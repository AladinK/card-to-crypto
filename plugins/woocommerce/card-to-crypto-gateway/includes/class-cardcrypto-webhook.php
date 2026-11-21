<?php
/**
 * Receives signed CardCrypto webhooks at /wp-json/card-to-crypto/v1/webhook.
 *
 * Response codes (the backend retries anything that is not a 2xx):
 *   200  handled, ignored, or already processed
 *   400  malformed request or invalid signature
 *   500  internal error or missing configuration, so the backend retries later
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Verifies and applies one webhook delivery.
 */
final class CardCrypto_Webhook {

	public const REST_NAMESPACE = 'card-to-crypto/v1';
	public const REST_ROUTE     = '/webhook';
	public const OPTION_EVENTS  = 'cardcrypto_processed_event_ids';
	public const MAX_REMEMBERED = 500;

	private const MAX_BODY_BYTES = 262144;

	/**
	 * Creates a handler for one delivery.
	 *
	 * @param string $secret Webhook signing secret (whsec_...). Empty means not configured.
	 * @param string $mode   "test" or "live", from the API key. Empty skips the livemode check.
	 */
	public function __construct(
		private readonly string $secret,
		private readonly string $mode
	) {
	}

	/** Registers the REST route. Called on rest_api_init. */
	public static function register_route(): void {
		register_rest_route(
			self::REST_NAMESPACE,
			self::REST_ROUTE,
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( self::class, 'handle_rest' ),
				// Authentication is the HMAC signature, checked in process(). The WordPress cookie and
				// nonce layer must not apply to a server-to-server call, so access is open here by design.
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * REST entry point. Reads the raw body from php://input, because the signature covers the exact bytes.
	 *
	 * @param WP_REST_Request $request The incoming request.
	 */
	public static function handle_rest( WP_REST_Request $request ): WP_REST_Response {
		$settings = WC_Gateway_CardCrypto::saved_settings();
		$handler  = new self(
			(string) ( $settings['webhook_secret'] ?? '' ),
			CardCrypto_Api::mode_for_key( (string) ( $settings['secret_key'] ?? '' ) )
		);

		$raw_body = file_get_contents( 'php://input' );
		$result   = $handler->process(
			false === $raw_body ? '' : $raw_body,
			$request->get_header( 'cardcrypto-signature' ),
			time()
		);

		return new WP_REST_Response( $result['body'], $result['status'] );
	}

	/**
	 * Verifies one delivery and applies it. Takes plain inputs, so it can be tested with a fixed body,
	 * signature and clock.
	 *
	 * @param string      $raw_body         Exact request body bytes.
	 * @param string|null $signature_header Value of the CardCrypto-Signature header.
	 * @param int         $now              Current Unix time in seconds.
	 * @return array{status: int, body: array<string, mixed>}
	 */
	public function process( string $raw_body, ?string $signature_header, int $now ): array {
		if ( '' === $this->secret ) {
			CardCrypto_Logger::error( 'CardCrypto webhook received, but no webhook signing secret is saved in the gateway settings.' );
			return self::response( 500, 'webhook_not_configured' );
		}

		if ( '' === $raw_body || strlen( $raw_body ) > self::MAX_BODY_BYTES ) {
			return self::response( 400, 'invalid_body' );
		}

		if ( ! CardCrypto_Signature::verify( $signature_header, $raw_body, $this->secret, $now ) ) {
			CardCrypto_Logger::warning( 'CardCrypto webhook rejected: signature check failed.' );
			return self::response( 400, 'invalid_signature' );
		}

		// Only signed bodies reach the JSON parser.
		try {
			$event = json_decode( $raw_body, true, 32, JSON_THROW_ON_ERROR );
		} catch ( JsonException $e ) {
			$event = null;
		}

		if ( ! is_array( $event ) || ! is_string( $event['id'] ?? null ) || ! is_string( $event['event'] ?? null )
			|| 1 !== preg_match( '/^[A-Za-z0-9_.-]{1,255}$/', $event['id'] ) ) {
			return self::response( 400, 'invalid_payload' );
		}

		$event_id = $event['id'];
		$context  = array(
			'event_id' => $event_id,
			'event'    => $event['event'],
		);

		if ( $this->is_other_mode( $event ) ) {
			CardCrypto_Logger::warning( 'CardCrypto webhook ignored: livemode does not match the mode of the saved API key.', $context );
			return self::response( 200, 'ignored_mode_mismatch' );
		}

		if ( in_array( $event_id, $this->remembered_ids(), true ) ) {
			CardCrypto_Logger::debug( 'CardCrypto webhook already processed; acknowledged.', $context );
			return self::response( 200, 'duplicate' );
		}

		try {
			$this->dispatch( $event );
		} catch ( Throwable $e ) {
			// Not remembered, so the backend's retry is processed in full.
			CardCrypto_Logger::error( 'CardCrypto webhook failed; the backend will retry.', $context + array( 'error' => $e->getMessage() ) );
			return self::response( 500, 'internal_error' );
		}

		$this->remember( $event_id );
		CardCrypto_Logger::debug( 'CardCrypto webhook processed.', $context );

		return self::response( 200, 'received' );
	}

	/**
	 * Routes a verified event to its handler. Unknown types are acknowledged and ignored.
	 *
	 * @param array<string, mixed> $event Decoded event.
	 */
	private function dispatch( array $event ): void {
		match ( $event['event'] ) {
			'payment.captured'     => $this->on_payment_captured( $event ),
			'payment.failed'       => $this->on_payment_closed( $event, 'failed' ),
			'payment.cancelled'    => $this->on_payment_closed( $event, 'cancelled' ),
			'settlement.confirmed' => $this->on_settlement_confirmed( $event ),
			'settlement.failed'    => $this->on_settlement_failed( $event ),
			'refund.completed'     => $this->on_refund( $event, 'completed' ),
			'refund.failed'        => $this->on_refund( $event, 'failed' ),
			// payment.created, payment.authorized, conversion.completed, settlement.created and
			// refund.created are acknowledged without changing the order.
			default                => null,
		};
	}

	/**
	 * Handles payment.captured: completes a pending or on-hold order when the amount and currency match.
	 *
	 * @param array<string, mixed> $event Decoded event.
	 * @throws RuntimeException When WooCommerce cannot save the order (the backend then retries).
	 */
	private function on_payment_captured( array $event ): void {
		$payment_id = self::payment_id_of( $event );
		$order      = null === $payment_id ? null : self::order_for_payment( $payment_id );
		if ( null === $order ) {
			CardCrypto_Logger::debug( 'CardCrypto payment.captured for a payment that is not linked to an order; ignored.' );
			return;
		}

		if ( $order->get_transaction_id() === $payment_id ) {
			return; // Already completed, for example by the return page.
		}

		if ( ! WC_Gateway_CardCrypto::event_matches_order( $event, $order ) ) {
			$order->add_order_note( sprintf( 'CardCrypto reported a captured payment (%s) whose order, amount or currency does not match this order. The order was not changed; review it in the CardCrypto dashboard.', $payment_id ) );
			return;
		}

		if ( ! in_array( $order->get_status(), WC_Gateway_CardCrypto::OPEN_ORDER_STATUSES, true ) ) {
			$order->add_order_note( sprintf( 'CardCrypto reported a captured payment (%1$s) while this order is %2$s. The order was not changed automatically.', $payment_id, $order->get_status() ) );
			return;
		}

		WC_Gateway_CardCrypto::complete_order_for_payment( $order, $payment_id );
	}

	/**
	 * Handles payment.failed and payment.cancelled: moves a pending order to failed or cancelled, and leaves other statuses alone.
	 *
	 * @param array<string, mixed> $event      Decoded event.
	 * @param string               $new_status Order status to set: failed or cancelled.
	 */
	private function on_payment_closed( array $event, string $new_status ): void {
		$payment_id = self::payment_id_of( $event );
		$order      = null === $payment_id ? null : self::order_for_payment( $payment_id );
		if ( null === $order || 'pending' !== $order->get_status() ) {
			return; // Only an order that is still waiting for payment is moved.
		}

		$reason = self::clean_text( $event['reason'] ?? '' );
		$order->update_status(
			$new_status,
			sprintf( 'CardCrypto payment %s %s%s.', $payment_id, $new_status, '' !== $reason ? " ({$reason})" : '' )
		);
	}

	/**
	 * Handles settlement.confirmed: adds a note with the network and transaction hash. The status is not changed.
	 *
	 * @param array<string, mixed> $event Decoded event.
	 */
	private function on_settlement_confirmed( array $event ): void {
		$payment_id = self::payment_id_of( $event );
		$order      = null === $payment_id ? null : self::order_for_payment( $payment_id );
		if ( null === $order ) {
			return;
		}

		$order->add_order_note(
			sprintf(
				'CardCrypto settlement confirmed for payment %1$s: %2$s %3$s on %4$s, transaction %5$s.',
				$payment_id,
				self::clean_text( $event['crypto_amount'] ?? 'unknown amount' ),
				self::clean_text( $event['crypto_asset'] ?? '' ),
				self::clean_text( $event['network'] ?? 'unknown network' ),
				self::clean_text( $event['tx_hash'] ?? 'not reported' )
			)
		);
	}

	/**
	 * Handles settlement.failed: adds an action-required note. The status is not changed.
	 *
	 * @param array<string, mixed> $event Decoded event.
	 */
	private function on_settlement_failed( array $event ): void {
		$payment_id = self::payment_id_of( $event );
		$order      = null === $payment_id ? null : self::order_for_payment( $payment_id );
		if ( null === $order ) {
			return;
		}

		$order->add_order_note(
			sprintf(
				'ACTION REQUIRED: CardCrypto could not settle payment %1$s (%2$s). The card payment was captured and the order status is unchanged. Resolve the crypto transfer in the CardCrypto dashboard.',
				$payment_id,
				self::clean_text( $event['reason'] ?? 'no reason given' )
			)
		);
	}

	/**
	 * Handles refund.completed and refund.failed: adds a note only. Refunds are never created by this plugin.
	 *
	 * @param array<string, mixed> $event   Decoded event.
	 * @param string               $outcome completed or failed.
	 */
	private function on_refund( array $event, string $outcome ): void {
		$payment_id = self::payment_id_of( $event );
		$order      = null === $payment_id ? null : self::order_for_payment( $payment_id );
		if ( null === $order ) {
			return;
		}

		$order->add_order_note(
			sprintf(
				'CardCrypto refund %1$s %2$s: %3$s %4$s.',
				self::clean_text( $event['refund_id'] ?? 'unknown' ),
				$outcome,
				self::clean_text( $event['fiat_amount'] ?? '' ),
				self::clean_text( $event['fiat_currency'] ?? '' )
			)
		);
	}

	/**
	 * True when the event's livemode disagrees with the mode of the saved API key.
	 *
	 * @param array<string, mixed> $event Decoded event.
	 */
	private function is_other_mode( array $event ): bool {
		if ( '' === $this->mode || ! is_bool( $event['livemode'] ?? null ) ) {
			return false;
		}

		return $event['livemode'] !== ( 'live' === $this->mode );
	}

	/**
	 * Event ids already applied (bounded list, see MAX_REMEMBERED).
	 *
	 * @return list<string>
	 */
	private function remembered_ids(): array {
		$ids = get_option( self::OPTION_EVENTS, array() );

		return is_array( $ids ) ? array_values( array_filter( $ids, 'is_string' ) ) : array();
	}

	/**
	 * Records an applied event id, keeping only the newest MAX_REMEMBERED.
	 *
	 * @param string $event_id Event id.
	 */
	private function remember( string $event_id ): void {
		$ids   = $this->remembered_ids();
		$ids[] = $event_id;

		update_option( self::OPTION_EVENTS, array_slice( $ids, -self::MAX_REMEMBERED ), false );
	}

	/**
	 * Returns the payment id when it has an expected format, otherwise null.
	 *
	 * @param array<string, mixed> $event Decoded event.
	 */
	private static function payment_id_of( array $event ): ?string {
		$payment_id = $event['payment_id'] ?? null;

		return is_string( $payment_id ) && 1 === preg_match( '/^[A-Za-z0-9_-]{3,100}$/', $payment_id ) ? $payment_id : null;
	}

	/**
	 * Finds the CardCrypto order that stores this payment id.
	 *
	 * @param string $payment_id Payment id.
	 */
	private static function order_for_payment( string $payment_id ): ?WC_Order {
		// Exact lookup of one id, limited to orders paid with this gateway. See readme.txt, limitations.
		// phpcs:disable WordPress.DB.SlowDBQuery.slow_db_query_meta_key, WordPress.DB.SlowDBQuery.slow_db_query_meta_value
		$orders = wc_get_orders(
			array(
				'limit'          => 1,
				'payment_method' => WC_Gateway_CardCrypto::GATEWAY_ID,
				'meta_key'       => WC_Gateway_CardCrypto::META_PAYMENT,
				'meta_value'     => $payment_id,
			)
		);
		// phpcs:enable WordPress.DB.SlowDBQuery.slow_db_query_meta_key, WordPress.DB.SlowDBQuery.slow_db_query_meta_value

		$order = is_array( $orders ) ? reset( $orders ) : null;

		return $order instanceof WC_Order ? $order : null;
	}

	/**
	 * Keeps values short and free of markup before they go into an order note.
	 *
	 * @param mixed $value Raw value from the event.
	 */
	private static function clean_text( mixed $value ): string {
		$text = is_scalar( $value ) ? sanitize_text_field( (string) $value ) : '';

		return substr( $text, 0, 120 );
	}

	/**
	 * Builds the handler's return value.
	 *
	 * @param int    $status HTTP status to return.
	 * @param string $reason Short machine-readable reason.
	 * @return array{status: int, body: array<string, mixed>}
	 */
	private static function response( int $status, string $reason ): array {
		return array(
			'status' => $status,
			'body'   => array(
				'received' => $status < 300,
				'reason'   => $reason,
			),
		);
	}
}
