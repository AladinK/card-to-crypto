<?php
/**
 * Verifies CardCrypto webhook signatures.
 *
 * Pure PHP on purpose: no WordPress or WooCommerce functions are called here, so the
 * verifier can be tested on its own (see tests/SignatureTest.php).
 *
 * Header:    CardCrypto-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]
 * Signature: lowercase hex HMAC-SHA256 over "<t>.<raw body>", keyed with the endpoint secret.
 * Contract:  backend/src/core/security.ts (verifyWebhookSignature) and sdk/src/webhooks.ts.
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Checks the CardCrypto-Signature header against the raw request body.
 */
final class CardCrypto_Signature {

	/** Maximum distance, in seconds, between the signed timestamp and the current time. */
	public const TOLERANCE_SECONDS = 300;

	/**
	 * Returns true only when the header is well formed, the timestamp is within the tolerance
	 * window, and at least one v1 value equals the expected HMAC. The check is constant-time.
	 *
	 * @param string|null $header   Raw value of the CardCrypto-Signature header.
	 * @param string      $raw_body Exact request body bytes, before any JSON parsing.
	 * @param string      $secret   Webhook signing secret (whsec_...).
	 * @param int         $now      Current Unix time in seconds.
	 * @param int         $tolerance Allowed skew in seconds, inclusive.
	 */
	public static function verify(
		?string $header,
		string $raw_body,
		string $secret,
		int $now,
		int $tolerance = self::TOLERANCE_SECONDS
	): bool {
		if ( null === $header || '' === $secret || $tolerance < 0 ) {
			return false;
		}

		$parsed = self::parse_header( $header );
		if ( null === $parsed ) {
			return false;
		}

		list( $timestamp, $signatures ) = $parsed;

		// Replay protection: a captured request stops working once the window has passed.
		if ( abs( $now - $timestamp ) > $tolerance ) {
			return false;
		}

		$expected = hash_hmac( 'sha256', $timestamp . '.' . $raw_body, $secret );

		foreach ( $signatures as $candidate ) {
			if ( hash_equals( $expected, $candidate ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Splits the header into its timestamp and v1 signatures.
	 *
	 * A duplicate or malformed timestamp rejects the whole header. Malformed v1 entries are
	 * ignored, because they could never match the 64-character expected digest anyway.
	 *
	 * @param string $header Raw header value.
	 * @return array{0: int, 1: list<string>}|null
	 */
	private static function parse_header( string $header ): ?array {
		$timestamp  = null;
		$signatures = array();

		foreach ( explode( ',', $header ) as $part ) {
			$pair = explode( '=', trim( $part ), 2 );
			if ( 2 !== count( $pair ) ) {
				continue;
			}

			$key   = trim( $pair[0] );
			$value = trim( $pair[1] );

			if ( 't' === $key ) {
				if ( null !== $timestamp || 1 !== preg_match( '/^\d{1,12}$/', $value ) ) {
					return null;
				}
				$timestamp = (int) $value;
			} elseif ( 'v1' === $key && 1 === preg_match( '/^[a-f0-9]{64}$/', $value ) ) {
				$signatures[] = $value;
			}
		}

		if ( null === $timestamp || array() === $signatures ) {
			return null;
		}

		return array( $timestamp, $signatures );
	}
}
