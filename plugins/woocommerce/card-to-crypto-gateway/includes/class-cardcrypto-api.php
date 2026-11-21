<?php
/**
 * HTTP client for the CardCrypto API, built on wp_remote_request().
 *
 * Every call has a 15 second timeout and does not follow redirects, so the bearer token is never
 * sent to a host other than the configured API base URL. Failures are mapped to
 * CardCrypto_Api_Exception, whose category says whether the same Idempotency-Key may be retried.
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

// phpcs:disable WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Exception messages are logged, never printed.

/**
 * Client for the CardCrypto API routes that the plugin uses.
 */
final class CardCrypto_Api {

	/** Seconds before a request is abandoned. */
	public const TIMEOUT_SECONDS = 15;

	/** Payment ids are letters, digits, "_" and "-". Anything else never reaches a URL. */
	private const ID_PATTERN = '/^[A-Za-z0-9_-]{3,100}$/';

	/**
	 * Base URL without a trailing slash.
	 *
	 * @var string
	 */
	private string $base_url;

	/**
	 * Creates a client for one API origin and key.
	 *
	 * @param string $base_url   Absolute http(s) origin, optionally with a path prefix.
	 * @param string $secret_key sk_test_... or sk_live_...; the prefix selects the mode.
	 * @throws CardCrypto_Api_Exception When the base URL is not an absolute http(s) URL.
	 */
	public function __construct( string $base_url, private readonly string $secret_key ) {
		$this->base_url = rtrim( trim( $base_url ), '/' );

		// Absolute http(s) origin, optionally with a path prefix; no query or fragment.
		if ( 1 !== preg_match( '#^https?://[^/\s?\#]+(/[^\s?\#]*)?$#i', $this->base_url ) ) {
			throw new CardCrypto_Api_Exception( 'not_configured', null, null, null, array(), 'The API base URL must be an absolute http or https URL.' );
		}
	}

	/**
	 * Returns "test" or "live" from the secret key prefix, or "" for an unknown prefix.
	 *
	 * @param string $secret_key Secret key.
	 */
	public static function mode_for_key( string $secret_key ): string {
		if ( str_starts_with( $secret_key, 'sk_live_' ) ) {
			return 'live';
		}

		return str_starts_with( $secret_key, 'sk_test_' ) ? 'test' : '';
	}

	/** Returns the mode of the configured secret key. */
	public function mode(): string {
		return self::mode_for_key( $this->secret_key );
	}

	/**
	 * GET /healthz. No authentication.
	 *
	 * @return array<string, mixed>
	 * @throws CardCrypto_Api_Exception On any failure.
	 */
	public function health(): array {
		return $this->request( 'GET', '/healthz', null, null, false );
	}

	/**
	 * Confirms that the secret key is accepted. GET /v1/me is dashboard-only and rejects API keys,
	 * so a one-item payment list is used instead.
	 *
	 * @return array<string, mixed>
	 * @throws CardCrypto_Api_Exception On any failure.
	 */
	public function verify_key(): array {
		return $this->request( 'GET', '/v1/payments?limit=1', null, null, true );
	}

	/**
	 * POST /v1/payments. The same body and key always return the same payment, so a retry after a
	 * transient failure is safe.
	 *
	 * @param array<string, mixed> $body            Request body (only schema keys).
	 * @param string               $idempotency_key 8 to 255 characters.
	 * @return array<string, mixed> The created payment.
	 * @throws CardCrypto_Api_Exception On any failure.
	 */
	public function create_payment( array $body, string $idempotency_key ): array {
		$length = strlen( $idempotency_key );
		if ( $length < 8 || $length > 255 ) {
			throw new CardCrypto_Api_Exception( 'local', null, null, null, array(), 'Idempotency-Key must be 8 to 255 characters.' );
		}

		$payment = $this->request( 'POST', '/v1/payments', $body, $idempotency_key, true );

		if ( ! is_string( $payment['id'] ?? null ) || 1 !== preg_match( self::ID_PATTERN, $payment['id'] )
			|| ! is_string( $payment['status'] ?? null ) || ! is_string( $payment['checkout_url'] ?? null ) ) {
			throw new CardCrypto_Api_Exception( 'bad_response', 201, null, null, array(), 'The create-payment response is missing id, status or checkout_url.' );
		}

		return $payment;
	}

	/**
	 * GET /v1/payments/{id}.
	 *
	 * @param string $payment_id Payment id.
	 * @return array<string, mixed>
	 * @throws CardCrypto_Api_Exception With category not_found when the id is unknown in this mode.
	 */
	public function get_payment( string $payment_id ): array {
		if ( 1 !== preg_match( self::ID_PATTERN, $payment_id ) ) {
			throw new CardCrypto_Api_Exception( 'local', null, null, null, array(), 'Payment id has an unexpected format.' );
		}

		return $this->request( 'GET', '/v1/payments/' . rawurlencode( $payment_id ), null, null, true );
	}

	// phpcs:disable Squiz.Commenting.FunctionCommentThrowTag.WrongNumber -- Both throws are CardCrypto_Api_Exception; the sniff cannot resolve the factory call.
	/**
	 * Sends one request and returns the decoded JSON object of a 2xx response.
	 *
	 * @param string                    $method        HTTP method.
	 * @param string                    $path          Path with optional query string.
	 * @param array<string, mixed>|null $body          JSON body, or null.
	 * @param string|null               $idempotency_key Idempotency-Key header, or null.
	 * @param bool                      $authenticated Whether to send the bearer token.
	 * @return array<string, mixed>
	 * @throws CardCrypto_Api_Exception When the body cannot be encoded or the request cannot be sent.
	 * @throws CardCrypto_Api_Exception When the API answers with an error or with a body that is not a JSON object.
	 */
	private function request( string $method, string $path, ?array $body, ?string $idempotency_key, bool $authenticated ): array {
		$headers = array(
			'Accept'     => 'application/json',
			'User-Agent' => 'CardCrypto-WooCommerce/' . CARDCRYPTO_WC_VERSION,
		);

		if ( $authenticated ) {
			$headers['Authorization'] = 'Bearer ' . $this->secret_key;
		}

		$args = array(
			'method'      => $method,
			'timeout'     => self::TIMEOUT_SECONDS,
			'redirection' => 0,
			'headers'     => $headers,
		);

		if ( null !== $body ) {
			$encoded = wp_json_encode( $body, JSON_UNESCAPED_SLASHES );
			if ( false === $encoded ) {
				throw new CardCrypto_Api_Exception( 'local', null, null, null, array(), 'The request body could not be encoded as JSON.' );
			}

			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = $encoded;
		}

		if ( null !== $idempotency_key ) {
			$args['headers']['Idempotency-Key'] = $idempotency_key;
		}

		$started  = microtime( true );
		$response = wp_remote_request( $this->base_url . $path, $args );
		$elapsed  = (int) round( ( microtime( true ) - $started ) * 1000 );

		if ( is_wp_error( $response ) ) {
			CardCrypto_Logger::debug(
				'CardCrypto API request failed before a response.',
				array(
					'method'      => $method,
					'path'        => $path,
					'duration_ms' => $elapsed,
				)
			);
			throw new CardCrypto_Api_Exception( 'network', null, null, null, array(), 'Network error: ' . $response->get_error_message() );
		}

		$status  = (int) wp_remote_retrieve_response_code( $response );
		$decoded = self::decode_json( (string) wp_remote_retrieve_body( $response ) );

		CardCrypto_Logger::debug(
			'CardCrypto API call.',
			array(
				'method'      => $method,
				'path'        => $path,
				'http_status' => $status,
				'duration_ms' => $elapsed,
			)
		);

		if ( $status >= 200 && $status < 300 ) {
			if ( null === $decoded ) {
				throw new CardCrypto_Api_Exception( 'bad_response', $status, null, null, array(), 'The API returned a body that is not a JSON object.' );
			}

			return $decoded;
		}

		throw self::exception_for_error( $status, $decoded );
	}

	// phpcs:enable Squiz.Commenting.FunctionCommentThrowTag.WrongNumber

	/**
	 * Maps an error response (the backend error envelope) to an exception with a category.
	 *
	 * @param int                       $status  HTTP status.
	 * @param array<string, mixed>|null $decoded Decoded body, or null.
	 */
	private static function exception_for_error( int $status, ?array $decoded ): CardCrypto_Api_Exception {
		$error      = is_array( $decoded['error'] ?? null ) ? $decoded['error'] : array();
		$code       = is_string( $error['code'] ?? null ) ? $error['code'] : null;
		$request_id = is_string( $error['request_id'] ?? null ) ? $error['request_id'] : null;
		$details    = is_array( $error['details'] ?? null ) ? $error['details'] : array();
		$message    = is_string( $error['message'] ?? null ) ? substr( $error['message'], 0, 300 ) : 'no message';

		$category = match ( true ) {
			'idempotency_in_progress' === $code => 'busy',
			429 === $status => 'rate_limited',
			401 === $status, 403 === $status => 'auth',
			404 === $status => 'not_found',
			409 === $status => 'conflict',
			400 === $status, 422 === $status => 'invalid_request',
			$status >= 500 => 'server',
			default => 'unexpected',
		};

		return new CardCrypto_Api_Exception(
			$category,
			$status,
			$code,
			$request_id,
			$details,
			sprintf( 'CardCrypto API returned HTTP %1$d (%2$s): %3$s', $status, $code ?? 'no code', $message )
		);
	}

	/**
	 * Decodes a JSON object, or returns null when the text is empty or not a JSON object.
	 *
	 * @param string $raw Response body.
	 * @return array<string, mixed>|null
	 */
	private static function decode_json( string $raw ): ?array {
		if ( '' === $raw ) {
			return null;
		}

		try {
			$data = json_decode( $raw, true, 64, JSON_THROW_ON_ERROR );
		} catch ( JsonException $e ) {
			return null;
		}

		return is_array( $data ) ? $data : null;
	}
}

// phpcs:enable WordPress.Security.EscapeOutput.ExceptionNotEscaped
