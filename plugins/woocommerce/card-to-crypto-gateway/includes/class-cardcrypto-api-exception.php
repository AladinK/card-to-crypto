<?php
/**
 * Failure raised by the CardCrypto API client and by the gateway's payment steps.
 *
 * The message is written to the WooCommerce log only. Customers see the generic notice, never this text.
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

// phpcs:disable WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Messages are logged, never printed.

/**
 * Failure from the CardCrypto API client or from a gateway payment step.
 */
final class CardCrypto_Api_Exception extends RuntimeException {

	/**
	 * Creates the exception.
	 *
	 * Categories: network, busy, rate_limited, server, bad_response, unexpected (transient); auth,
	 * not_found, conflict, invalid_request (definitive); local and not_configured (no request was sent).
	 *
	 * @param string               $category    Failure category, see above.
	 * @param int|null             $http_status HTTP status of the response, when there was one.
	 * @param string|null          $api_code    error.code from the API envelope.
	 * @param string|null          $request_id  error.request_id from the API envelope.
	 * @param array<string, mixed> $details     error.details from the API envelope.
	 * @param string               $message     Log message.
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

	/**
	 * Whether the same Idempotency-Key may be sent again. The request may or may not have been applied,
	 * so the retry must reuse the key.
	 */
	public function is_transient(): bool {
		return in_array( $this->category, array( 'network', 'busy', 'rate_limited', 'server', 'bad_response', 'unexpected' ), true );
	}

	/**
	 * Whether the API answered with a 4xx. The backend stores that answer under the key, so the next
	 * attempt needs a new key.
	 */
	public function is_definitive(): bool {
		return in_array( $this->category, array( 'auth', 'not_found', 'conflict', 'invalid_request' ), true );
	}
}

// phpcs:enable WordPress.Security.EscapeOutput.ExceptionNotEscaped
