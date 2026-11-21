<?php
/**
 * "Pay by card" gateway. The customer pays on the CardCrypto hosted checkout; the merchant
 * receives USDC or USDT on their own wallet.
 *
 * Order meta used by this class:
 *   _cardcrypto_payment_id  id of the CardCrypto payment for the order (the one to reuse or check)
 *   _cardcrypto_attempt     number of the last Idempotency-Key that was spent (see start_card_payment())
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

class WC_Gateway_CardCrypto extends WC_Payment_Gateway {

	public const GATEWAY_ID           = 'cardcrypto';
	public const META_PAYMENT         = '_cardcrypto_payment_id';
	public const META_ATTEMPT         = '_cardcrypto_attempt';
	public const OPTION_KEY           = 'woocommerce_cardcrypto_settings';
	public const OPEN_ORDER_STATUSES  = array( 'pending', 'on-hold' );
	public const SUPPORTED_CURRENCIES = array( 'EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'RSD' );

	/** Payment statuses in which the customer's money has been captured (backend core/states.ts). */
	private const PAID_STATUSES = array(
		'PAYMENT_CAPTURED',
		'CONVERSION_PENDING',
		'CONVERSION_COMPLETED',
		'CRYPTO_TRANSFER_PENDING',
		'CRYPTO_TRANSFER_SUBMITTED',
		'CRYPTO_CONFIRMING',
		'SETTLED',
		'PARTIALLY_REFUNDED',
		'REFUNDED',
	);

	/** Payment statuses in which the hosted checkout can still be paid. */
	private const OPEN_STATUSES = array( 'CREATED', 'PAYMENT_PENDING' );

	private const TEST_RESULT_PREFIX = 'cardcrypto_test_result_';

	public function __construct() {
		$this->id                 = self::GATEWAY_ID;
		$this->icon               = '';
		$this->has_fields         = false;
		$this->method_title       = __( 'Card-to-Crypto', 'card-to-crypto-gateway' );
		$this->method_description = __( 'Accept card payments on a normal checkout. The merchant receives USDC or USDT in their own wallet.', 'card-to-crypto-gateway' );
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();

		$this->title       = (string) $this->get_option( 'title' );
		$this->description = (string) $this->get_option( 'description' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_action( 'woocommerce_thankyou_' . $this->id, array( $this, 'thankyou_page' ) );
	}

	public function init_form_fields() {
		$this->form_fields = array(
			'enabled'         => array(
				'title'   => __( 'Enable/Disable', 'card-to-crypto-gateway' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable card payments with Card-to-Crypto', 'card-to-crypto-gateway' ),
				'default' => 'no',
			),
			'title'           => array(
				'title'       => __( 'Title', 'card-to-crypto-gateway' ),
				'type'        => 'text',
				'description' => __( 'Shown to customers at checkout.', 'card-to-crypto-gateway' ),
				'default'     => __( 'Pay by card', 'card-to-crypto-gateway' ),
				'desc_tip'    => true,
			),
			'description'     => array(
				'title'   => __( 'Description', 'card-to-crypto-gateway' ),
				'type'    => 'textarea',
				'default' => __( 'You will be taken to a secure card payment page to complete your order.', 'card-to-crypto-gateway' ),
			),
			'api_base_url'    => array(
				'title'       => __( 'API base URL', 'card-to-crypto-gateway' ),
				'type'        => 'text',
				'description' => __( 'Origin of the CardCrypto API, for example https://api.example.com. Plain http is accepted for localhost only.', 'card-to-crypto-gateway' ),
				'default'     => 'http://localhost:3000',
				'desc_tip'    => true,
			),
			'secret_key'      => array(
				'title'       => __( 'Secret key', 'card-to-crypto-gateway' ),
				'type'        => 'password',
				'description' => __( 'Starts with sk_test_ (test mode) or sk_live_ (live mode). The saved key is never shown; leave blank to keep it.', 'card-to-crypto-gateway' ),
				'default'     => '',
			),
			'webhook_secret'  => array(
				'title'       => __( 'Webhook signing secret', 'card-to-crypto-gateway' ),
				'type'        => 'password',
				'description' => __( 'Starts with whsec_. Shown once when the webhook endpoint is created. Leave blank to keep the saved secret.', 'card-to-crypto-gateway' ),
				'default'     => '',
			),
			'show_powered_by' => array(
				'title'   => __( 'Powered by', 'card-to-crypto-gateway' ),
				'type'    => 'checkbox',
				'label'   => __( 'Show "Powered by Crypto Settlement" under the payment method', 'card-to-crypto-gateway' ),
				'default' => 'no',
			),
			'debug'           => array(
				'title'   => __( 'Debug log', 'card-to-crypto-gateway' ),
				'type'    => 'checkbox',
				'label'   => __( 'Log every API call to WooCommerce > Status > Logs. Secrets are never logged.', 'card-to-crypto-gateway' ),
				'default' => 'no',
			),
		);
	}

	/**
	 * Adds the webhook URL and a connection test below the standard settings table.
	 * The test uses the saved settings, so it is a separate link rather than a form button.
	 */
	public function admin_options() {
		parent::admin_options();

		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return;
		}

		$test_url = wp_nonce_url( admin_url( 'admin-post.php?action=cardcrypto_test_connection' ), 'cardcrypto_test_connection' );
		$hook_url = rest_url( CardCrypto_Webhook::REST_NAMESPACE . CardCrypto_Webhook::REST_ROUTE );
		?>
		<h2><?php esc_html_e( 'Webhook and connection', 'card-to-crypto-gateway' ); ?></h2>
		<p>
			<?php esc_html_e( 'Webhook URL. Use this when you create the webhook endpoint in CardCrypto:', 'card-to-crypto-gateway' ); ?><br />
			<code><?php echo esc_url( $hook_url ); ?></code>
		</p>
		<p>
			<a class="button button-secondary" href="<?php echo esc_url( $test_url ); ?>"><?php esc_html_e( 'Test connection', 'card-to-crypto-gateway' ); ?></a>
			<span class="description"><?php esc_html_e( 'Tests the saved settings. Save your changes first.', 'card-to-crypto-gateway' ); ?></span>
		</p>
		<?php
	}

	/**
	 * Password-style row that never prints the saved value. The saved key is shown only as a
	 * masked placeholder, and a blank submission keeps the saved key (see the validate_* methods).
	 *
	 * @param string               $key  Field key.
	 * @param array<string, mixed> $data Field data.
	 */
	public function generate_password_html( $key, $data ) {
		$field_key = $this->get_field_key( $key );
		$data      = wp_parse_args(
			$data,
			array(
				'title'       => '',
				'class'       => '',
				'css'         => '',
				'disabled'    => false,
				'description' => '',
				'desc_tip'    => false,
			)
		);

		$saved       = (string) $this->get_option( $key );
		$placeholder = '' === $saved ? '' : self::mask_secret( $saved );

		ob_start();
		?>
		<tr valign="top">
			<th scope="row" class="titledesc">
				<label for="<?php echo esc_attr( $field_key ); ?>"><?php echo wp_kses_post( $data['title'] ); ?> <?php echo $this->get_tooltip_html( $data ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Sanitized by WooCommerce. ?></label>
			</th>
			<td class="forminp">
				<fieldset>
					<legend class="screen-reader-text"><span><?php echo wp_kses_post( $data['title'] ); ?></span></legend>
					<input class="input-text regular-input <?php echo esc_attr( $data['class'] ); ?>" type="password" name="<?php echo esc_attr( $field_key ); ?>" id="<?php echo esc_attr( $field_key ); ?>" style="<?php echo esc_attr( $data['css'] ); ?>" value="" placeholder="<?php echo esc_attr( $placeholder ); ?>" autocomplete="new-password" <?php disabled( $data['disabled'], true ); ?> />
					<?php echo $this->get_description_html( $data ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Sanitized by WooCommerce. ?>
				</fieldset>
			</td>
		</tr>
		<?php

		return (string) ob_get_clean();
	}

	/** @param mixed $value */
	public function validate_secret_key_field( $key, $value ) {
		$submitted = trim( (string) wp_unslash( (string) $value ) );

		if ( '' === $submitted ) {
			return (string) $this->get_option( $key ); // Keep the saved key.
		}

		if ( 1 !== preg_match( '/^sk_(?:test|live)_[A-Za-z0-9_-]{16,200}$/', $submitted ) ) {
			throw new Exception( __( 'The secret key must start with sk_test_ or sk_live_ and contain only letters, digits, "_" and "-".', 'card-to-crypto-gateway' ) );
		}

		return $submitted;
	}

	/** @param mixed $value */
	public function validate_webhook_secret_field( $key, $value ) {
		$submitted = trim( (string) wp_unslash( (string) $value ) );

		if ( '' === $submitted ) {
			return (string) $this->get_option( $key ); // Keep the saved secret.
		}

		if ( 1 !== preg_match( '/^whsec_[A-Za-z0-9_-]{16,200}$/', $submitted ) ) {
			throw new Exception( __( 'The webhook signing secret must start with whsec_.', 'card-to-crypto-gateway' ) );
		}

		return $submitted;
	}

	/** @param mixed $value */
	public function validate_api_base_url_field( $key, $value ) {
		$url   = rtrim( trim( (string) wp_unslash( (string) $value ) ), '/' );
		$parts = ( '' === $url || 1 === preg_match( '/\s/', $url ) ) ? false : parse_url( $url );

		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] )
			|| isset( $parts['query'] ) || isset( $parts['fragment'] ) || isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			throw new Exception( __( 'The API base URL must be an absolute http or https URL, for example https://api.example.com.', 'card-to-crypto-gateway' ) );
		}

		$scheme = strtolower( (string) $parts['scheme'] );
		$host   = strtolower( (string) $parts['host'] );
		if ( 'https' !== $scheme && ! ( 'http' === $scheme && in_array( $host, array( 'localhost', '127.0.0.1' ), true ) ) ) {
			throw new Exception( __( 'Plain http is accepted for localhost only. Use https for a remote API.', 'card-to-crypto-gateway' ) );
		}

		return $url;
	}

	public function is_available() {
		if ( ! parent::is_available() ) {
			return false;
		}

		if ( '' === (string) $this->get_option( 'secret_key' ) ) {
			return false;
		}

		return in_array( strtoupper( (string) get_woocommerce_currency() ), self::SUPPORTED_CURRENCIES, true );
	}

	public function needs_setup() {
		return '' === (string) $this->get_option( 'secret_key' );
	}

	public function payment_fields() {
		$description = $this->get_description();
		if ( '' !== $description ) {
			echo wp_kses_post( wpautop( wptexturize( $description ) ) );
		}

		if ( 'yes' === $this->get_option( 'show_powered_by' ) ) {
			echo '<p class="cardcrypto-powered-by"><small>' . esc_html__( 'Powered by Crypto Settlement', 'card-to-crypto-gateway' ) . '</small></p>';
		}
	}

	/**
	 * Starts a card payment for the order and sends the customer to the hosted checkout.
	 *
	 * @param int $order_id
	 * @return array{result: string, redirect?: string}
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return $this->start_failed();
		}

		try {
			return $this->start_card_payment( $order );
		} catch ( CardCrypto_Api_Exception $e ) {
			CardCrypto_Logger::error(
				'Card payment could not be started.',
				array(
					'order_id'    => $order->get_id(),
					'category'    => $e->category,
					'http_status' => $e->http_status ?? 0,
					'api_code'    => $e->api_code ?? 'none',
					'request_id'  => $e->request_id ?? 'none',
					'message'     => $e->getMessage(),
				)
			);
		} catch ( Throwable $e ) {
			CardCrypto_Logger::error( 'Unexpected error while starting a card payment.', array( 'order_id' => $order->get_id(), 'error' => $e->getMessage() ) );
		}

		return $this->start_failed();
	}

	/**
	 * Return-page check. The URL the customer comes back to is not trusted, so this looks the
	 * payment up in the API and completes the order only when the money has been captured.
	 *
	 * @param int $order_id
	 */
	public function thankyou_page( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || ! in_array( $order->get_status(), self::OPEN_ORDER_STATUSES, true ) ) {
			return;
		}

		$payment_id = (string) $order->get_meta( self::META_PAYMENT, true );
		if ( '' === $payment_id ) {
			return;
		}

		try {
			$payment = $this->api()->get_payment( $payment_id );
		} catch ( Throwable $e ) {
			CardCrypto_Logger::error( 'Could not confirm the card payment on the return page. The webhook will complete the order.', array( 'order_id' => $order->get_id(), 'error' => $e->getMessage() ) );
			return;
		}

		$status = (string) ( $payment['status'] ?? '' );
		if ( ! in_array( $status, self::PAID_STATUSES, true ) || ! self::payment_matches_order( $payment, $order ) ) {
			CardCrypto_Logger::debug( 'Return page: card payment not captured yet.', array( 'order_id' => $order->get_id(), 'status' => $status ) );
			return;
		}

		try {
			self::complete_order_for_payment( $order, $payment_id );
		} catch ( Throwable $e ) {
			CardCrypto_Logger::error( 'Return page could not complete the order.', array( 'order_id' => $order->get_id(), 'error' => $e->getMessage() ) );
		}
	}

	/**
	 * Marks an order paid for a captured CardCrypto payment. Shared by the return page and the webhook.
	 *
	 * @return string 'completed', 'already_completed' or 'not_open'.
	 * @throws RuntimeException When WooCommerce cannot save the order (the webhook is then retried).
	 */
	public static function complete_order_for_payment( WC_Order $order, string $payment_id ): string {
		if ( $order->get_transaction_id() === $payment_id ) {
			return 'already_completed';
		}

		if ( ! in_array( $order->get_status(), self::OPEN_ORDER_STATUSES, true ) ) {
			return 'not_open';
		}

		if ( ! $order->payment_complete( $payment_id ) ) {
			throw new RuntimeException( 'WooCommerce did not complete order ' . $order->get_id() . ' for payment ' . $payment_id . '.' );
		}

		$order->add_order_note( sprintf( 'CardCrypto payment %s captured. Order marked as paid.', $payment_id ) );

		return 'completed';
	}

	/** True when the webhook's amount, currency and order id match the order. */
	public static function event_matches_order( array $event, WC_Order $order ): bool {
		return self::terms_match(
			(string) ( $event['order_id'] ?? '' ),
			(string) ( $event['fiat_amount'] ?? '' ),
			(string) ( $event['fiat_currency'] ?? '' ),
			$order
		);
	}

	/** True when a payment fetched from the API belongs to this order with the same amount and currency. */
	public static function payment_matches_order( array $payment, WC_Order $order ): bool {
		return self::terms_match(
			(string) ( $payment['order_id'] ?? '' ),
			(string) ( $payment['amount'] ?? '' ),
			(string) ( $payment['currency'] ?? '' ),
			$order
		);
	}

	/** Shows only the prefix and the last four characters, for the placeholder. */
	public static function mask_secret( string $secret ): string {
		$prefix = '';
		if ( 1 === preg_match( '/^(sk_(?:test|live)_|whsec_)/', $secret, $matches ) ) {
			$prefix = $matches[1];
		}

		$tail = strlen( $secret ) >= 16 ? substr( $secret, -4 ) : '';

		return $prefix . str_repeat( '*', 8 ) . $tail;
	}

	/** @return array<string, mixed> */
	public static function saved_settings(): array {
		$settings = get_option( self::OPTION_KEY, array() );

		return is_array( $settings ) ? $settings : array();
	}

	/**
	 * Calls GET /healthz and an authenticated endpoint with the saved key, and returns a result
	 * for the admin notice. Nothing secret is included in the message.
	 *
	 * @return array{ok: bool, message: string}
	 */
	public static function check_connection( CardCrypto_Api $api ): array {
		try {
			$health = $api->health();
			if ( 'ok' !== ( $health['status'] ?? null ) ) {
				return self::connection_result( false, __( 'The API health check returned an unexpected response.', 'card-to-crypto-gateway' ) );
			}

			$api->verify_key();
		} catch ( CardCrypto_Api_Exception $e ) {
			return self::connection_result( false, self::describe_connection_failure( $e ) );
		}

		$mode = $api->mode();

		return self::connection_result(
			true,
			'' === $mode
				? __( 'Connection OK. The API accepted the secret key.', 'card-to-crypto-gateway' )
				/* translators: %s: "test" or "live". */
				: sprintf( __( 'Connection OK. The API accepted the secret key (%s mode).', 'card-to-crypto-gateway' ), $mode )
		);
	}

	/** admin-post handler for the "Test connection" link. */
	public static function handle_test_connection(): void {
		check_admin_referer( 'cardcrypto_test_connection' );

		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to test this connection.', 'card-to-crypto-gateway' ), '', array( 'response' => 403 ) );
		}

		try {
			$result = self::check_connection( self::api_for_settings( self::saved_settings() ) );
		} catch ( Throwable $e ) {
			$result = self::connection_result( false, __( 'The gateway is not configured. Save the API base URL and the secret key first.', 'card-to-crypto-gateway' ) );
		}

		set_transient( self::TEST_RESULT_PREFIX . get_current_user_id(), $result, 120 );

		wp_safe_redirect( admin_url( 'admin.php?page=wc-settings&tab=checkout&section=' . self::GATEWAY_ID . '&cardcrypto_test=1' ) );
		exit;
	}

	/** admin_notices callback: shows the result of the last connection test once. */
	public static function render_test_notice(): void {
		if ( ! isset( $_GET['section'], $_GET['cardcrypto_test'] ) || self::GATEWAY_ID !== sanitize_key( wp_unslash( $_GET['section'] ) ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Display only.
			return;
		}

		$key    = self::TEST_RESULT_PREFIX . get_current_user_id();
		$result = get_transient( $key );
		if ( ! is_array( $result ) ) {
			return;
		}

		delete_transient( $key );

		printf(
			'<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>',
			! empty( $result['ok'] ) ? 'success' : 'error',
			esc_html( (string) ( $result['message'] ?? '' ) )
		);
	}

	/** @param array<string, mixed> $settings */
	public static function api_for_settings( array $settings ): CardCrypto_Api {
		$base_url = (string) ( $settings['api_base_url'] ?? '' );
		$secret   = (string) ( $settings['secret_key'] ?? '' );

		if ( '' === $base_url || '' === $secret ) {
			throw new CardCrypto_Api_Exception( 'not_configured', null, null, null, array(), 'The API base URL or the secret key is not saved.' );
		}

		return new CardCrypto_Api( $base_url, $secret );
	}

	private function api(): CardCrypto_Api {
		return self::api_for_settings(
			array(
				'api_base_url' => $this->get_option( 'api_base_url' ),
				'secret_key'   => $this->get_option( 'secret_key' ),
			)
		);
	}

	/**
	 * Creates the payment, or reuses the open one, and returns the redirect to the hosted checkout.
	 *
	 * Idempotency: the key is "cardcrypto-wc-<order>-<n>", where n = stored attempt + 1. The stored
	 * attempt moves only when a key has been spent, that is, when it created a payment we keep or
	 * when the API answered with a definitive 4xx. A transient failure (network, 5xx, timeout)
	 * leaves n unchanged, so retrying the same attempt replays the same result.
	 *
	 * @return array{result: string, redirect?: string}
	 * @throws CardCrypto_Api_Exception
	 */
	private function start_card_payment( WC_Order $order ): array {
		$api      = $this->api();
		$amount   = self::order_amount( $order );
		$currency = self::order_currency( $order );

		$payment_id = (string) $order->get_meta( self::META_PAYMENT, true );
		if ( '' !== $payment_id ) {
			$existing = $this->payment_or_null( $api, $payment_id );

			if ( null !== $existing ) {
				$status  = (string) ( $existing['status'] ?? '' );
				$matches = self::payment_matches_order( $existing, $order );

				if ( self::money_captured( $existing ) ) {
					if ( $matches && in_array( $status, self::PAID_STATUSES, true ) ) {
						if ( 'not_open' === self::complete_order_for_payment( $order, $payment_id ) ) {
							$order->add_order_note( sprintf( 'CardCrypto payment %s is captured while this order is %s. The order was not changed automatically.', $payment_id, $order->get_status() ) );
						}
						return $this->success( $this->get_return_url( $order ) );
					}

					// Captured money must never lead to a second payment for the same order.
					$order->add_order_note( sprintf( 'CardCrypto payment %s is %s and was not replaced. Review it in the CardCrypto dashboard.', $payment_id, $status ) );
					CardCrypto_Logger::error( 'Captured card payment found for an order that is not paid; no new payment created.', array( 'order_id' => $order->get_id(), 'status' => $status ) );
					return $this->start_failed();
				}

				if ( $matches && in_array( $status, self::OPEN_STATUSES, true ) ) {
					CardCrypto_Logger::debug( 'Reusing the open card checkout.', array( 'order_id' => $order->get_id(), 'status' => $status ) );
					return $this->success( self::checkout_url_from( $existing ) );
				}

				if ( $matches && 'PAYMENT_AUTHORIZED' === $status ) {
					return $this->start_failed(); // Being captured right now; the customer can retry shortly.
				}
				// Otherwise the stored payment is closed (FAILED, CANCELLED), expired, or open for other terms: a new payment follows.
			}
		}

		$key_number = (int) $order->get_meta( self::META_ATTEMPT, true ) + 1;

		try {
			$created = $api->create_payment(
				$this->payment_body( $order, $amount, $currency ),
				self::idempotency_key( $order, $key_number )
			);
		} catch ( CardCrypto_Api_Exception $e ) {
			if ( 'payment_already_open' === $e->api_code && is_string( $e->details['payment_id'] ?? null ) ) {
				$adopted = $this->adopt_open_payment( $api, $order, $e->details['payment_id'], $key_number );
				if ( null !== $adopted ) {
					return $adopted;
				}
			}

			if ( $e->is_definitive() ) {
				self::remember_attempt( $order, $key_number );
			}

			throw $e;
		}

		$url = self::checkout_url_from( $created );
		self::remember_attempt( $order, $key_number, (string) $created['id'] );

		CardCrypto_Logger::debug( 'Card payment created.', array( 'order_id' => $order->get_id(), 'attempt' => $key_number ) );

		return $this->success( $url );
	}

	/**
	 * The API reports an open payment for this order (for example after a lost response). Adopt it
	 * when it matches the order and can still be paid; otherwise return null.
	 *
	 * @return array{result: string, redirect: string}|null
	 */
	private function adopt_open_payment( CardCrypto_Api $api, WC_Order $order, string $payment_id, int $key_number ): ?array {
		$payment = $this->payment_or_null( $api, $payment_id );
		if ( null === $payment || ! self::payment_matches_order( $payment, $order ) || ! in_array( (string) ( $payment['status'] ?? '' ), self::OPEN_STATUSES, true ) ) {
			return null;
		}

		$url = self::checkout_url_from( $payment );
		self::remember_attempt( $order, $key_number, $payment_id );

		return $this->success( $url );
	}

	/** @return array<string, mixed>|null Null when the API does not know the payment in this mode. */
	private function payment_or_null( CardCrypto_Api $api, string $payment_id ): ?array {
		try {
			return $api->get_payment( $payment_id );
		} catch ( CardCrypto_Api_Exception $e ) {
			if ( 'not_found' === $e->category ) {
				return null;
			}

			throw $e;
		}
	}

	/**
	 * Body for POST /v1/payments. Only keys the backend schema accepts are sent (it rejects unknown keys).
	 *
	 * @return array<string, mixed>
	 */
	private function payment_body( WC_Order $order, string $amount, string $currency ): array {
		$body = array(
			'amount'      => $amount,
			'currency'    => $currency,
			'order_id'    => (string) $order->get_id(),
			'description' => substr( sprintf( __( 'Order %s', 'card-to-crypto-gateway' ), $order->get_order_number() ), 0, 250 ),
			'return_url'  => $this->get_return_url( $order ),
			'cancel_url'  => $order->get_cancel_order_url_raw(),
			'metadata'    => array(
				'platform'        => 'woocommerce',
				'plugin_version'  => CARDCRYPTO_WC_VERSION,
				'wc_order_number' => (string) $order->get_order_number(),
			),
		);

		$email = trim( (string) $order->get_billing_email() );
		if ( '' !== $email && strlen( $email ) <= 254 && is_email( $email ) ) {
			$body['customer'] = array( 'email' => $email );
		}

		return $body;
	}

	private static function idempotency_key( WC_Order $order, int $key_number ): string {
		return sprintf( 'cardcrypto-wc-%d-%d', $order->get_id(), $key_number );
	}

	private static function remember_attempt( WC_Order $order, int $key_number, ?string $payment_id = null ): void {
		$order->update_meta_data( self::META_ATTEMPT, $key_number );
		if ( null !== $payment_id ) {
			$order->update_meta_data( self::META_PAYMENT, $payment_id );
		}
		$order->save();
	}

	private static function order_amount( WC_Order $order ): string {
		$amount = wc_format_decimal( $order->get_total(), 2 );

		if ( 1 !== preg_match( '/^\d{1,12}\.\d{2}$/', $amount ) || '0.00' === $amount ) {
			throw new CardCrypto_Api_Exception( 'local', null, null, null, array(), 'The order total is not a positive amount.' );
		}

		return $amount;
	}

	private static function order_currency( WC_Order $order ): string {
		$currency = strtoupper( (string) $order->get_currency() );

		if ( ! in_array( $currency, self::SUPPORTED_CURRENCIES, true ) ) {
			throw new CardCrypto_Api_Exception( 'local', null, null, null, array(), 'The order currency is not supported by CardCrypto.' );
		}

		return $currency;
	}

	/** @param array<string, mixed> $payment */
	private static function checkout_url_from( array $payment ): string {
		$url = $payment['checkout_url'] ?? null;

		if ( ! is_string( $url ) || 1 !== preg_match( '#^https?://#i', $url ) || false === filter_var( $url, FILTER_VALIDATE_URL ) ) {
			throw new CardCrypto_Api_Exception( 'bad_response', null, null, null, array(), 'The payment has no valid checkout URL.' );
		}

		return $url;
	}

	/** Captured, or captured and later failed in settlement: the money must not be charged again. */
	private static function money_captured( array $payment ): bool {
		return in_array( (string) ( $payment['status'] ?? '' ), self::PAID_STATUSES, true ) || ! empty( $payment['captured_at'] );
	}

	private static function terms_match( string $order_id, string $amount, string $currency, WC_Order $order ): bool {
		return $order_id === (string) $order->get_id()
			&& $amount === wc_format_decimal( $order->get_total(), 2 )
			&& strtoupper( $currency ) === strtoupper( (string) $order->get_currency() );
	}

	/** @return array{result: string, redirect: string} */
	private function success( string $redirect ): array {
		return array(
			'result'   => 'success',
			'redirect' => $redirect,
		);
	}

	/** Shows the one customer-facing message for every failure. Details go to the log only. */
	private function start_failed(): array {
		wc_add_notice( __( 'We could not start the card payment. Please try again.', 'card-to-crypto-gateway' ), 'error' );

		return array( 'result' => 'failure' );
	}

	/** @return array{ok: bool, message: string} */
	private static function connection_result( bool $ok, string $message ): array {
		return array(
			'ok'      => $ok,
			'message' => $message,
		);
	}

	private static function describe_connection_failure( CardCrypto_Api_Exception $e ): string {
		return match ( $e->category ) {
			'network'  => __( 'Could not reach the API. Check the API base URL and that the server is running.', 'card-to-crypto-gateway' ),
			'auth'     => __( 'The API rejected the secret key. Check that you pasted the full key.', 'card-to-crypto-gateway' ),
			default    => sprintf( __( 'The API answered with an error (HTTP %s).', 'card-to-crypto-gateway' ), (string) ( $e->http_status ?? 'unknown' ) ),
		};
	}
}
