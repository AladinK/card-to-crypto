<?php
/**
 * TEST HARNESS, NOT THE REAL API.
 *
 * An in-memory stand-in for the CardCrypto backend routes the plugin calls. It follows the rules of
 * backend/src/api/routes/payments.ts and backend/src/idempotency/index.ts that the plugin relies on:
 *   - the same Idempotency-Key with the same body replays the stored response;
 *   - the same key with a different body returns 422 idempotency_key_reused;
 *   - 4xx responses are stored under their key and replayed (5xx are not);
 *   - a second open payment for one order returns 409 payment_already_open with details.payment_id,
 *     or 409 order_amount_mismatch when the terms differ;
 *   - GET /v1/me rejects API keys (it is dashboard-only), as the backend does.
 *
 * @package CardCryptoGateway
 */

final class FakeCardCryptoApi {

	public const BASE = 'https://api.cardcrypto.test';

	/** @var array<string, array<string, mixed>> payment id => payment view */
	public array $payments = array();

	/** @var array<string, array{hash: string, status: int, body: array<string, mixed>}> */
	public array $idempotency = array();

	/** @var list<array{method: string, path: string, headers: array<string, string>, body: mixed, timeout: mixed, redirection: mixed}> */
	public array $calls = array();

	/** Forced responses, consumed in order: 'network', or array('status' => int, 'body' => array). */
	public array $queue = array();

	public function __construct( private readonly string $accepted_key ) {
	}

	/** Matches the signature of wp_remote_request's test seam: returns a WP-shaped response or WP_Error. */
	public function transport( string $url, array $args ) {
		$method  = (string) ( $args['method'] ?? 'GET' );
		$path    = substr( $url, strlen( self::BASE ) );
		$headers = (array) ( $args['headers'] ?? array() );
		$raw     = isset( $args['body'] ) ? (string) $args['body'] : '';
		$body    = '' === $raw ? null : json_decode( $raw, true );

		$this->calls[] = array(
			'method'      => $method,
			'path'        => $path,
			'headers'     => $headers,
			'body'        => $body,
			'timeout'     => $args['timeout'] ?? null,
			'redirection' => $args['redirection'] ?? null,
		);

		if ( array() !== $this->queue ) {
			$forced = array_shift( $this->queue );
			if ( 'network' === $forced ) {
				return new WP_Error( 'http_request_failed', 'cURL error 28: Operation timed out after 15001 milliseconds' );
			}

			return $this->wp_response( (int) $forced['status'], (array) $forced['body'] );
		}

		if ( 'GET' === $method && '/healthz' === $path ) {
			return $this->wp_response( 200, array( 'status' => 'ok' ) );
		}

		if ( ! isset( $headers['Authorization'] ) || 'Bearer ' . $this->accepted_key !== $headers['Authorization'] ) {
			return $this->wp_response( 401, $this->error( 'unauthorized', 'Invalid API key.' ) );
		}

		if ( 'GET' === $method && '/v1/me' === $path ) {
			return $this->wp_response( 401, $this->error( 'unauthorized', 'Authentication required.' ) );
		}

		if ( 'GET' === $method && '/v1/payments?limit=1' === $path ) {
			return $this->wp_response( 200, array( 'data' => array() ) );
		}

		if ( 'POST' === $method && '/v1/payments' === $path ) {
			return $this->create( $headers, $raw, is_array( $body ) ? $body : array() );
		}

		if ( 'GET' === $method && 1 === preg_match( '#^/v1/payments/([A-Za-z0-9_-]+)$#', $path, $m ) ) {
			if ( ! isset( $this->payments[ $m[1] ] ) ) {
				return $this->wp_response( 404, $this->error( 'not_found', 'Payment not found.' ) );
			}

			return $this->wp_response( 200, $this->payments[ $m[1] ] );
		}

		return $this->wp_response( 404, $this->error( 'not_found', 'Route not found.' ) );
	}

	/** Changes a payment's status the way the backend would after a webhook-level event. */
	public function set_payment( string $id, array $fields ): void {
		$this->payments[ $id ] = array_merge( $this->payments[ $id ] ?? array(), $fields );
	}

	/** @param array<string, string> $headers */
	private function create( array $headers, string $raw, array $body ): array {
		$key = (string) ( $headers['Idempotency-Key'] ?? '' );
		if ( strlen( $key ) < 8 || strlen( $key ) > 255 ) {
			return $this->wp_response( 400, $this->error( 'idempotency_key_required', 'Idempotency-Key must be 8 to 255 characters.' ) );
		}

		$hash = hash( 'sha256', $raw );
		if ( isset( $this->idempotency[ $key ] ) ) {
			$stored = $this->idempotency[ $key ];
			if ( $stored['hash'] !== $hash ) {
				return $this->wp_response( 422, $this->error( 'idempotency_key_reused', 'This Idempotency-Key was already used with different parameters.' ) );
			}

			return $this->wp_response( $stored['status'], $stored['body'] );
		}

		$result = $this->create_payment( $key, $body );
		if ( $result['status'] < 500 ) {
			$this->idempotency[ $key ] = array(
				'hash'   => $hash,
				'status' => $result['status'],
				'body'   => $result['body'],
			);
		}

		return $this->wp_response( $result['status'], $result['body'] );
	}

	/** @return array{status: int, body: array<string, mixed>} */
	private function create_payment( string $key, array $body ): array {
		$order_id = (string) ( $body['order_id'] ?? '' );

		foreach ( $this->payments as $payment ) {
			$open = in_array( $payment['status'], array( 'CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED' ), true );
			if ( $open && $payment['order_id'] === $order_id ) {
				$same_terms = $payment['amount'] === ( $body['amount'] ?? null ) && $payment['currency'] === ( $body['currency'] ?? null );

				return array(
					'status' => 409,
					'body'   => $this->error(
						$same_terms ? 'payment_already_open' : 'order_amount_mismatch',
						'The order already has an open payment.',
						array( 'payment_id' => $payment['id'] )
					),
				);
			}
		}

		$id = 'pay_' . substr( hash( 'sha256', $key . '|' . $order_id ), 0, 24 );

		$this->payments[ $id ] = array(
			'id'              => $id,
			'object'          => 'payment',
			'mode'            => 'test',
			'status'          => 'PAYMENT_PENDING',
			'order_id'        => $order_id,
			'amount'          => (string) $body['amount'],
			'currency'        => (string) $body['currency'],
			'refunded_amount' => '0.00',
			'checkout_url'    => 'https://pay.cardcrypto.test/checkout/' . $id . '?t=tok_' . substr( $id, 4, 8 ),
			'captured_at'     => null,
			'failure_reason'  => null,
			'metadata'        => $body['metadata'] ?? array(),
		);

		return array( 'status' => 201, 'body' => $this->payments[ $id ] );
	}

	/** @return array{error: array{type: string, code: string, message: string, details: array<string, mixed>, request_id: string}} */
	private function error( string $code, string $message, array $details = array() ): array {
		return array(
			'error' => array(
				'type'       => 'invalid_request',
				'code'       => $code,
				'message'    => $message,
				'details'    => $details,
				'request_id' => 'req_test_0001',
			),
		);
	}

	/** @param array<string, mixed> $body */
	private function wp_response( int $status, array $body ): array {
		return array(
			'response' => array( 'code' => $status ),
			'body'     => (string) json_encode( $body, JSON_UNESCAPED_SLASHES ),
		);
	}
}
