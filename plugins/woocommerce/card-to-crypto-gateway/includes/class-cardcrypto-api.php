<?php
/**
 * HTTP client for the CardCrypto API, built on wp_remote_request().
 *
 * Every call has a 15 second timeout and does not follow redirects, so the bearer token is
 * never sent to a host other than the configured API base URL. Failures are mapped to
 * CardCrypto_Api_Exception with a category that tells the caller whether the same
 * Idempotency-Key may be retried (transient) or the attempt is over (definitive).
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Raised for every failed API call. The message is for logs only; customers never see it.
 */
final class CardCrypto_Api_Exception extends RuntimeException {

	/**
	 * @param string               $category    network, busy, rate_limited, server, bad_response, unexpected,
	 *                                          auth, not_found, conflict, invalid_request, not_configured, local.
	 * @param array<string, mixed> $details     The API's error.details object, when present.
	 */
	public function __construct(
		public readonly string $category,
		public readonly ?int $http_status,
		public readonly ?string $api_code,
		public readonly ?string $request_id,
		public readonly array $details,
		string $message
	) {
		parent::__construct( $message );
	}

	/** The same Idempotency-Key may be sent again: the request may or may not have been applied. */
	public function is_transient(): bool {
		return in_array( $this->category, array( 'network', 'busy', 'rate_limited', 'server', 'bad_response', 'unexpected' ), true );
	}

	/** The API answered with a 4xx: that key's result is stored by the backend and will be replayed. */
	public function is_definitive(): bool {
		return in_array( $this->category, array( 'auth', 'not_found', 'conflict', 'invalid_request' ), true );
	}
}

final class CardCrypto_Api {

	public const TIMEOUT_SECONDS = 15;

	private const ID_PATTERN = '/^[A-Za-z0-9_-]{3,100}$/';

	private string $base_url;

	public function __construct( string $base_url, private readonly string $secret_key ) {
		$this->base_url = rtrim( trim( $base_url ), '/' );
		// Absolute http(s) origin, optionally with a path prefix; no query or fragment.
		if ( 1 !== preg_match( '#^https?://[^/\s?\#]+(/[^\s?\#]*)?$#i', $this->base_url ) ) {
			throw new CardCrypto_Api_Exception( 'not_configured', null, null, null, array(), 'The API base URL must be an absolute http or https URL.' );
		}
	}

	/** "test" or "live", read from the secret key prefix; "" when the prefix is unknown. */
	public static function mode_for_key( string $secret_key ): string {
		if ( str_starts_with( $secret_key, 'sk_live_' ) ) {
			return 'live';
		}

		return str_starts_with( $secret_key, 'sk_test_' ) ? 'test' : '';
	}

	public function mode(): string {
		return self::mode_for_key( $this->secret_key );
	}

	/** GET /healthz (no authentication). */
	public function health(): array {
		return $this->request( 'GET', '/healthz', null, null, false );
	}

	/**
	 * Confirms that the secret key is accepted. GET /v1/me is dashboard-only (it rejects API keys),
	 * so a one-item payment list is used instead.
	 */
	public function verify_key(): array {
		return $this->request( 'GET', '/v1/payments?limit=1', null, null, true );
	}

	/**
	 * POST /v1/payments. The same body and key always return the same payment, so a retry after a
	 * transient failure is safe.
	 *
	 * @param array<string, mixed> $body
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

	/** GET /v1/payments/{id}. Throws a not_found exception when the id is unknown in this mode. */
	public function get_payment( string $payment_id ): array {
		if ( 1 !== preg_match( self::ID_PATTERN, $payment_id ) ) {
			throw new CardCrypto_Api_Exception( 'local', null, null, null, array(), 'Payment id has an unexpected format.' );
		}

		return $this->request( 'GET', '/v1/payments/' . rawurlencode( $payment_id ), null, null, true );
	}

	/**
	 * Sends one request and returns the decoded JSON object of a 2xx response.
	 *
	 * @param array<string, mixed>|null $body
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
			$args['headers']['Content-Type'] = 'application/json';
			try {
				$args['body'] = json_encode( $body, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR );
			} catch ( JsonException $e ) {
				throw new CardCrypto_Api_Exception( 'local', null, null, null, array(), 'Request body could not be encoded as JSON.' );
			}
		}

		if ( null !== $idempotency_key ) {
			$args['headers']['Idempotency-Key'] = $idempotency_key;
		}

		$started  = microtime( true );
		$response = wp_remote_request( $this->base_url . $path, $args );
		$elapsed  = (int) round( ( microtime( true ) - $started ) * 1000 );

		if ( is_wp_error( $response ) ) {
			CardCrypto_Logger::debug( 'CardCrypto API request failed before a response.', array( 'method' => $method, 'path' => $path, 'duration_ms' => $elapsed ) );
			throw new CardCrypto_Api_Exception( 'network', null, null, null, array(), 'Network error: ' . $response->get_error_message() );
		}

		$status  = (int) wp_remote_retrieve_response_code( $response );
		$decoded = self::decode_json( (string) wp_remote_retrieve_body( $response ) );

		CardCrypto_Logger::debug(
			'CardCrypto API call.',
			array( 'method' => $method, 'path' => $path, 'http_status' => $status, 'duration_ms' => $elapsed )
		);

		if ( $status >= 200 && $status < 300 ) {
			if ( null === $decoded ) {
				throw new CardCrypto_Api_Exception( 'bad_response', $status, null, null, array(), 'The API returned a body that is not a JSON object.' );
			}

			return $decoded;
		}

		throw self::exception_for_error( $status, $decoded );
	}

	/**
	 * Maps an error response (see the backend error envelope) to a category.
	 *
	 * @param array<string, mixed>|null $decoded
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
			sprintf( 'CardCrypto API returned HTTP %d (%s): %s', $status, $code ?? 'no code', $message )
		);
	}

	/** @return array<string, mixed>|null */
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
