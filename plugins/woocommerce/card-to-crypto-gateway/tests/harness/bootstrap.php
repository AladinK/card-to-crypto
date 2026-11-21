<?php
/**
 * Loads the plugin classes against the TEST HARNESS (not WordPress) and provides scenario helpers.
 *
 * @package CardCryptoGateway
 */

define( 'ABSPATH', __DIR__ . '/' );

require_once __DIR__ . '/assert.php';
require_once __DIR__ . '/wordpress-stubs.php';
require_once __DIR__ . '/fake-cardcrypto-api.php';

$plugin_dir = dirname( __DIR__, 2 ) . '/';
require_once $plugin_dir . 'includes/class-cardcrypto-signature.php';
require_once $plugin_dir . 'includes/class-cardcrypto-logger.php';
require_once $plugin_dir . 'includes/class-cardcrypto-api-exception.php';
require_once $plugin_dir . 'includes/class-cardcrypto-api.php';
require_once $plugin_dir . 'includes/class-cardcrypto-webhook.php';
require_once $plugin_dir . 'includes/class-wc-gateway-cardcrypto.php';

const CC_SECRET_KEY     = 'sk_test_HarnessKey0123456789abcdefXYZ';
const CC_WEBHOOK_SECRET = 'whsec_HarnessSecret_abcdefgh0123';
const CC_META_PAYMENT   = '_cardcrypto_payment_id';
const CC_META_ATTEMPT   = '_cardcrypto_attempt';

/** Keeps every log line from every scenario, so the secret check can see all of them. */
function cc_collect_logs(): void {
	$GLOBALS['cc_all_logs'] = array_merge( $GLOBALS['cc_all_logs'] ?? array(), $GLOBALS['cc']['logs'] ?? array() );
}

/**
 * Starts a scenario: clears the fake WordPress state, saves the gateway settings and returns
 * the gateway with a fresh fake backend attached as the HTTP transport.
 *
 * @param array<string, string> $overrides
 * @return array{0: WC_Gateway_CardCrypto, 1: FakeCardCryptoApi}
 */
function cc_start( array $overrides = array() ): array {
	cc_collect_logs();
	cc_harness_reset();

	$GLOBALS['cc']['options']['woocommerce_cardcrypto_settings'] = $overrides + array(
		'enabled'         => 'yes',
		'title'           => 'Pay by card',
		'description'     => 'Secure card payment.',
		'api_base_url'    => FakeCardCryptoApi::BASE,
		'secret_key'      => CC_SECRET_KEY,
		'webhook_secret'  => CC_WEBHOOK_SECRET,
		'show_powered_by' => 'yes',
		'debug'           => 'yes',
	);

	$fake                          = new FakeCardCryptoApi( CC_SECRET_KEY );
	$GLOBALS['cc']['transport'] = array( $fake, 'transport' );

	return array( new WC_Gateway_CardCrypto(), $fake );
}

function cc_order( int $id, string $total = '100.00', string $status = 'pending', string $email = 'buyer@example.com' ): WC_Order {
	$order = new WC_Order( $id, $total, 'EUR', $status, $email );
	$GLOBALS['cc']['orders'][ $id ] = $order;

	return $order;
}

/** @return list<array<string, mixed>> */
function cc_posts( FakeCardCryptoApi $fake ): array {
	return array_values( array_filter( $fake->calls, static fn( array $call ): bool => 'POST' === $call['method'] ) );
}

/** @return list<string> */
function cc_idempotency_keys( FakeCardCryptoApi $fake ): array {
	return array_map( static fn( array $call ): string => (string) ( $call['headers']['Idempotency-Key'] ?? '' ), cc_posts( $fake ) );
}

/** True when $fn throws any exception. */
function cc_throws( callable $fn ): bool {
	try {
		$fn();
	} catch ( Throwable $e ) {
		return true;
	}

	return false;
}

/** Notes added to an order, as one string for substring checks. */
function cc_notes( WC_Order $order ): string {
	return implode( "\n", $order->notes );
}

/** Every log line recorded by every scenario so far, joined for leak checks. */
function cc_all_log_text(): string {
	cc_collect_logs();
	$text = '';
	foreach ( $GLOBALS['cc_all_logs'] as $entry ) {
		$text .= $entry[1] . ' ' . json_encode( $entry[2] ) . "\n";
	}

	return $text;
}
