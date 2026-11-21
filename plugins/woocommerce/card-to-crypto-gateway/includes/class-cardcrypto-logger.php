<?php
/**
 * Writes to WooCommerce > Status > Logs, with credentials removed before anything is written.
 *
 * Errors and warnings are always written. Debug entries (request timings, flow decisions) are
 * written only when the gateway's "Debug log" setting is enabled.
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

/**
 * Writes gateway entries to WooCommerce's logger, with credentials removed first.
 */
final class CardCrypto_Logger {

	private const SOURCE = 'card-to-crypto-gateway';

	/**
	 * Writes a debug entry when the debug setting is on.
	 *
	 * @param string               $message Message without credentials.
	 * @param array<string, mixed> $context Scalar values only; arrays are dropped.
	 */
	public static function debug( string $message, array $context = array() ): void {
		if ( self::debug_enabled() ) {
			self::write( 'debug', $message, $context );
		}
	}

	/**
	 * Writes a warning. Always written.
	 *
	 * @param string               $message Message without credentials.
	 * @param array<string, mixed> $context Scalar values only.
	 */
	public static function warning( string $message, array $context = array() ): void {
		self::write( 'warning', $message, $context );
	}

	/**
	 * Writes an error. Always written.
	 *
	 * @param string               $message Message without credentials.
	 * @param array<string, mixed> $context Scalar values only.
	 */
	public static function error( string $message, array $context = array() ): void {
		self::write( 'error', $message, $context );
	}

	/** Whether the gateway's debug setting is on. */
	public static function debug_enabled(): bool {
		$settings = get_option( 'woocommerce_cardcrypto_settings', array() );

		return is_array( $settings ) && 'yes' === ( $settings['debug'] ?? 'no' );
	}

	/**
	 * Masks anything that looks like a credential. Applied to every message and string value, so a
	 * secret that reaches an exception message is still kept out of the log.
	 *
	 * @param string $text Text to clean.
	 */
	public static function redact( string $text ): string {
		$patterns     = array(
			'/sk_(?:test|live)_[A-Za-z0-9_-]+/',
			'/whsec_[A-Za-z0-9_-]+/',
			'/Bearer\s+[^\s,;"]+/i',
		);
		$replacements = array( '[redacted key]', '[redacted secret]', 'Bearer [redacted]' );

		return (string) preg_replace( $patterns, $replacements, $text );
	}

	/**
	 * Hands one entry to WooCommerce's logger.
	 *
	 * @param string               $level   debug, warning or error.
	 * @param string               $message Message.
	 * @param array<string, mixed> $context Context.
	 */
	private static function write( string $level, string $message, array $context ): void {
		if ( ! function_exists( 'wc_get_logger' ) ) {
			return;
		}

		$clean = array( 'source' => self::SOURCE );
		foreach ( $context as $name => $value ) {
			if ( is_string( $value ) ) {
				$clean[ (string) $name ] = self::redact( substr( $value, 0, 500 ) );
			} elseif ( is_int( $value ) || is_float( $value ) || is_bool( $value ) || null === $value ) {
				$clean[ (string) $name ] = $value;
			}
			// Arrays and objects are dropped on purpose: they may hold raw API payloads.
		}

		wc_get_logger()->log( $level, self::redact( $message ), $clean );
	}
}
