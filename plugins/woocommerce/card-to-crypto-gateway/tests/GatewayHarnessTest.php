<?php
/**
 * Gateway checks against the TEST HARNESS: WordPress/WooCommerce stand-ins and an in-memory fake backend.
 * This is not WordPress. See tests/harness/wordpress-stubs.php.
 *
 * Run: php tests/GatewayHarnessTest.php
 */

require_once __DIR__ . '/harness/bootstrap.php';

// --- Settings: secrets are never printed, and validation keeps saved values ---------------------

[ $gw ] = cc_start();

$secret_row = $gw->generate_password_html( 'secret_key', array( 'title' => 'Secret key' ) );
cc_check( 'settings row does not print the saved secret key', ! str_contains( $secret_row, CC_SECRET_KEY ) && ! str_contains( $secret_row, 'HarnessKey0123' ) );
cc_check( 'settings row shows only the masked key as placeholder', str_contains( $secret_row, 'placeholder="sk_test_********fXYZ"' ) );
cc_check( 'settings row input has an empty value attribute', str_contains( $secret_row, 'value=""' ) );

$webhook_row = $gw->generate_password_html( 'webhook_secret', array( 'title' => 'Webhook' ) );
cc_check( 'webhook secret is not printed either', ! str_contains( $webhook_row, CC_WEBHOOK_SECRET ) && ! str_contains( $webhook_row, 'HarnessSecret' ) );

cc_same( 'mask keeps only the prefix and the last four characters', 'whsec_********0123', WC_Gateway_CardCrypto::mask_secret( CC_WEBHOOK_SECRET ) );
cc_same( 'mask hides the tail of a short value', 'sk_test_********', WC_Gateway_CardCrypto::mask_secret( 'sk_test_short' ) );

cc_same( 'blank secret key keeps the saved key', CC_SECRET_KEY, $gw->validate_secret_key_field( 'secret_key', '' ) );
cc_same( 'null secret key (field not posted) keeps the saved key', CC_SECRET_KEY, $gw->validate_secret_key_field( 'secret_key', null ) );
cc_check( 'secret key without sk_ prefix is refused', cc_throws( static fn() => $gw->validate_secret_key_field( 'secret_key', 'pk_live_Something0123456789' ) ) );
cc_same( 'a new live key is accepted', 'sk_live_NewLiveKey0123456789abcdef', $gw->validate_secret_key_field( 'secret_key', 'sk_live_NewLiveKey0123456789abcdef' ) );
cc_same( 'blank webhook secret keeps the saved secret', CC_WEBHOOK_SECRET, $gw->validate_webhook_secret_field( 'webhook_secret', '' ) );
cc_check( 'webhook secret without whsec_ is refused', cc_throws( static fn() => $gw->validate_webhook_secret_field( 'webhook_secret', 'abc123' ) ) );

cc_same( 'trailing slash is removed from the base URL', 'https://api.example.com', $gw->validate_api_base_url_field( 'api_base_url', 'https://api.example.com/' ) );
cc_same( 'http is accepted for localhost', 'http://localhost:3000', $gw->validate_api_base_url_field( 'api_base_url', 'http://localhost:3000' ) );
foreach ( array( 'http://api.example.com', 'https://api.example.com/?x=1', 'ftp://api.example.com', 'not a url', 'https://user:pw@api.example.com' ) as $bad_url ) {
	cc_check( "base URL refused: {$bad_url}", cc_throws( static fn() => $gw->validate_api_base_url_field( 'api_base_url', $bad_url ) ) );
}

// --- Availability and checkout text ----------------------------------------------------------------

cc_check( 'gateway available when enabled, keyed and in EUR', $gw->is_available() );
$GLOBALS['cc']['currency'] = 'JPY';
cc_check( 'gateway hidden for a currency CardCrypto does not support', ! $gw->is_available() );
$GLOBALS['cc']['currency'] = 'EUR';

[ $disabled_gw ] = cc_start( array( 'enabled' => 'no' ) );
cc_check( 'gateway hidden when disabled', ! $disabled_gw->is_available() );

[ $nokey_gw ] = cc_start( array( 'secret_key' => '' ) );
cc_check( 'gateway hidden without a secret key, and needs setup', ! $nokey_gw->is_available() && $nokey_gw->needs_setup() );

ob_start();
$gw->payment_fields();
$checkout_html = (string) ob_get_clean();
cc_check( 'checkout shows "Powered by Crypto Settlement" when enabled', str_contains( $checkout_html, 'Powered by Crypto Settlement' ) );

[ $quiet_gw ] = cc_start( array( 'show_powered_by' => 'no' ) );
ob_start();
$quiet_gw->payment_fields();
cc_check( 'checkout hides the powered-by line when disabled', ! str_contains( (string) ob_get_clean(), 'Powered by' ) );

// --- process_payment: request body, headers and idempotency ----------------------------------------

[ $gw, $fake ] = cc_start();
$order42        = cc_order( 42, '100' );
$first          = $gw->process_payment( 42 );
$post           = cc_posts( $fake )[0] ?? array( 'method' => '', 'path' => '', 'headers' => array(), 'body' => array(), 'timeout' => null, 'redirection' => null );

cc_same( 'process_payment succeeds for a fresh order', 'success', $first['result'] ?? null );
cc_same( 'exactly one POST /v1/payments is sent', array( 'POST', '/v1/payments' ), array( $post['method'], $post['path'] ) );

$body = (array) $post['body'];
$expected_keys = array( 'amount', 'currency', 'order_id', 'description', 'return_url', 'cancel_url', 'metadata', 'customer' );
sort( $expected_keys );
$actual_keys = array_keys( $body );
sort( $actual_keys );
cc_same( 'body contains only keys the backend schema accepts', $expected_keys, $actual_keys );
cc_same( 'amount is a two-decimal string', '100.00', $body['amount'] ?? null );
cc_same( 'currency is the order currency', 'EUR', $body['currency'] ?? null );
cc_same( 'order_id is the WooCommerce order id as a string', '42', $body['order_id'] ?? null );
cc_same( 'customer email comes from billing', array( 'email' => 'buyer@example.com' ), $body['customer'] ?? null );
cc_same( 'return_url is the WooCommerce order-received URL', $gw->get_return_url( $order42 ), $body['return_url'] ?? null );
cc_same( 'cancel_url is the raw cancel-order URL', $order42->get_cancel_order_url_raw(), $body['cancel_url'] ?? null );
cc_same( 'description names the order', 'Order 42', $body['description'] ?? null );
cc_same( 'metadata is a flat map of strings', array( 'platform' => 'woocommerce', 'plugin_version' => '0.1.0', 'wc_order_number' => '42' ), $body['metadata'] ?? null );
cc_same( 'Idempotency-Key is the order id plus attempt 1', 'cardcrypto-wc-42-1', $post['headers']['Idempotency-Key'] ?? null );
cc_same( 'Authorization carries the saved secret key as a bearer token', 'Bearer ' . CC_SECRET_KEY, $post['headers']['Authorization'] ?? null );
cc_same( 'request timeout is 15 seconds', 15, $post['timeout'] );
cc_same( 'redirects are not followed, so the token stays with the API host', 0, $post['redirection'] );
cc_same( 'customer is redirected to the hosted checkout URL', $fake->payments[ $order42->get_meta( CC_META_PAYMENT ) ]['checkout_url'] ?? '', $first['redirect'] ?? null );
cc_check( 'payment id is stored on the order', isset( $fake->payments[ (string) $order42->get_meta( CC_META_PAYMENT ) ] ) );
cc_same( 'attempt 1 is stored on the order', '1', (string) $order42->get_meta( CC_META_ATTEMPT ) );

$gets_before = count( array_filter( $fake->calls, static fn( array $c ): bool => 'GET' === $c['method'] ) );
$again       = $gw->process_payment( 42 );
$gets_after  = count( array_filter( $fake->calls, static fn( array $c ): bool => 'GET' === $c['method'] ) );
cc_same( 'retry reuses the open checkout: no second POST', 1, count( cc_posts( $fake ) ) );
cc_same( 'retry checks the existing payment with one GET', $gets_before + 1, $gets_after );
cc_same( 'retry redirects to the same checkout URL', $first['redirect'] ?? null, $again['redirect'] ?? null );

$gw->process_payment( 42 ); // Still the same open payment; nothing new is created.
cc_same( 'a third retry still creates nothing', 1, count( cc_posts( $fake ) ) );

$order43 = cc_order( 43, '99.5' );
$gw->process_payment( 43 );
cc_same( 'a total of 99.5 is sent as 99.50', '99.50', cc_posts( $fake )[1]['body']['amount'] ?? null );

cc_order( 44, '10.00', 'pending', 'not-an-email' );
$gw->process_payment( 44 );
cc_check( 'an invalid billing email is left out of the request', ! array_key_exists( 'customer', cc_posts( $fake )[2]['body'] ?? array() ) );

// --- Transient failures keep the same key; definitive ones move to a new key -----------------------

$order45 = cc_order( 45, '20.00' );
$fake->queue[] = 'network';
$net_fail = $gw->process_payment( 45 );
cc_same( 'network failure gives the generic customer failure', 'failure', $net_fail['result'] ?? null );
cc_same( 'network failure leaves the attempt counter alone', '', (string) $order45->get_meta( CC_META_ATTEMPT ) );
cc_check( 'customer sees only the generic notice', in_array( array( 'error', 'We could not start the card payment. Please try again.' ), $GLOBALS['cc']['notices'], true ) );
$net_ok = $gw->process_payment( 45 );
cc_same( 'retry after a network failure succeeds', 'success', $net_ok['result'] ?? null );
cc_same( 'retry after a network failure reuses Idempotency-Key 1', array( 'cardcrypto-wc-45-1', 'cardcrypto-wc-45-1' ), array_slice( cc_idempotency_keys( $fake ), -2 ) );

$order46 = cc_order( 46, '20.00' );
$fake->queue[] = array( 'status' => 503, 'body' => array( 'error' => array( 'type' => 'api_error', 'code' => 'provider_unavailable', 'message' => 'busy', 'request_id' => 'req_1' ) ) );
cc_same( 'HTTP 503 is a failure', 'failure', $gw->process_payment( 46 )['result'] ?? null );
cc_same( 'HTTP 503 keeps Idempotency-Key 1 for the retry', '', (string) $order46->get_meta( CC_META_ATTEMPT ) );
$gw->process_payment( 46 );
cc_same( 'HTTP 503 then success uses the same key', array( 'cardcrypto-wc-46-1', 'cardcrypto-wc-46-1' ), array_slice( cc_idempotency_keys( $fake ), -2 ) );

$order47 = cc_order( 47, '20.00' );
$fake->queue[] = array( 'status' => 422, 'body' => array( 'error' => array( 'type' => 'invalid_request', 'code' => 'invalid_amount', 'message' => 'bad', 'request_id' => 'req_2' ) ) );
cc_same( 'a definitive 422 is a failure', 'failure', $gw->process_payment( 47 )['result'] ?? null );
cc_same( 'a definitive 422 spends attempt 1', '1', (string) $order47->get_meta( CC_META_ATTEMPT ) );
$gw->process_payment( 47 );
cc_same( 'the next try after a 422 uses Idempotency-Key 2', 'cardcrypto-wc-47-2', array_slice( cc_idempotency_keys( $fake ), -1 )[0] ?? null );

// --- A closed payment is replaced; a captured one is never replaced -----------------------------

$order48 = cc_order( 48, '30.00' );
$gw->process_payment( 48 );
$payment48 = (string) $order48->get_meta( CC_META_PAYMENT );
$fake->set_payment( $payment48, array( 'status' => 'FAILED', 'failure_reason' => 'card_declined' ) );
$gw->process_payment( 48 );
cc_same( 'a failed payment is replaced with attempt 2', 'cardcrypto-wc-48-2', array_slice( cc_idempotency_keys( $fake ), -1 )[0] ?? null );
cc_check( 'the order now points at the new payment', (string) $order48->get_meta( CC_META_PAYMENT ) !== $payment48 );

$order49 = cc_order( 49, '40.00' );
$gw->process_payment( 49 );
$payment49 = (string) $order49->get_meta( CC_META_PAYMENT );
$fake->set_payment( $payment49, array( 'status' => 'SETTLED', 'captured_at' => '2026-11-21T10:00:00Z' ) );
$posts_before_49 = count( cc_posts( $fake ) );
$settled        = $gw->process_payment( 49 );
cc_same( 'a captured payment completes the order instead of creating one', $posts_before_49, count( cc_posts( $fake ) ) );
cc_same( 'a captured payment redirects to the thank-you page', $gw->get_return_url( $order49 ), $settled['redirect'] ?? null );
cc_same( 'the order is marked paid once, with the payment id as transaction', $payment49, $order49->get_transaction_id() );
cc_same( 'the order is in processing after completion', 'processing', $order49->get_status() );

$order50 = cc_order( 50, '100.00' );
$gw->process_payment( 50 );
$payment50 = (string) $order50->get_meta( CC_META_PAYMENT );
$fake->set_payment( $payment50, array( 'status' => 'PAYMENT_CAPTURED', 'amount' => '1.00', 'captured_at' => '2026-11-21T10:00:00Z' ) );
$posts_before_50 = count( cc_posts( $fake ) );
$mismatch        = $gw->process_payment( 50 );
cc_same( 'captured payment with other terms fails the attempt', 'failure', $mismatch['result'] ?? null );
cc_same( 'captured payment with other terms creates no new payment', $posts_before_50, count( cc_posts( $fake ) ) );
cc_check( 'captured payment with other terms leaves the order unpaid and notes it', 'pending' === $order50->get_status() && str_contains( cc_notes( $order50 ), 'was not replaced' ) );

$order51 = cc_order( 51, '25.00' );
$gw->process_payment( 51 );
$payment51 = (string) $order51->get_meta( CC_META_PAYMENT );
$fake->set_payment( $payment51, array( 'status' => 'FAILED', 'captured_at' => '2026-11-21T10:00:00Z' ) );
$posts_before_51 = count( cc_posts( $fake ) );
cc_same( 'failure after capture (settlement failed) is not charged again', 'failure', $gw->process_payment( 51 )['result'] ?? null );
cc_same( 'failure after capture creates no new payment', $posts_before_51, count( cc_posts( $fake ) ) );

$order54 = cc_order( 54, '15.00' );
$gw->process_payment( 54 );
$fake->set_payment( (string) $order54->get_meta( CC_META_PAYMENT ), array( 'status' => 'SETTLED', 'captured_at' => '2026-11-21T10:00:00Z' ) );
$order54->update_status( 'cancelled' );
$cancelled_return = $gw->process_payment( 54 );
cc_same( 'a captured payment for a cancelled order still redirects to the return page', $gw->get_return_url( $order54 ), $cancelled_return['redirect'] ?? null );
cc_same( 'a captured payment for a cancelled order is not moved to paid', 'cancelled', $order54->get_status() );
cc_check( 'a captured payment for a cancelled order leaves a note for the merchant', str_contains( cc_notes( $order54 ), 'is captured while this order is cancelled' ) );

// --- Adopting an open payment the plugin lost track of -------------------------------------------

$order52 = cc_order( 52, '100.00' );
$order52->update_meta_data( CC_META_ATTEMPT, 1 );
$fake->payments['pay_adoptable0000000000000001'] = array(
	'id'           => 'pay_adoptable0000000000000001',
	'status'       => 'PAYMENT_PENDING',
	'order_id'     => '52',
	'amount'       => '100.00',
	'currency'     => 'EUR',
	'checkout_url' => 'https://pay.cardcrypto.test/checkout/pay_adoptable0000000000000001?t=adopt',
	'captured_at'  => null,
);
$adopted = $gw->process_payment( 52 );
cc_same( 'an open payment reported as payment_already_open is adopted', 'https://pay.cardcrypto.test/checkout/pay_adoptable0000000000000001?t=adopt', $adopted['redirect'] ?? null );
cc_same( 'the adopted payment id is stored on the order', 'pay_adoptable0000000000000001', (string) $order52->get_meta( CC_META_PAYMENT ) );
cc_same( 'adoption spends key 2 and does not reuse it', 'cardcrypto-wc-52-2', array_slice( cc_idempotency_keys( $fake ), -1 )[0] ?? null );

$order53 = cc_order( 53, '100.00' );
$fake->payments['pay_otherterms000000000000001'] = array(
	'id'           => 'pay_otherterms000000000000001',
	'status'       => 'PAYMENT_PENDING',
	'order_id'     => '53',
	'amount'       => '5.00',
	'currency'     => 'EUR',
	'checkout_url' => 'https://pay.cardcrypto.test/checkout/other',
	'captured_at'  => null,
);
cc_same( 'an open payment for other terms is not adopted', 'failure', $gw->process_payment( 53 )['result'] ?? null );
cc_same( 'the conflict spends attempt 1', '1', (string) $order53->get_meta( CC_META_ATTEMPT ) );
cc_same( 'an unknown order fails without any API call', 'failure', $gw->process_payment( 999 )['result'] ?? null );

// --- Return page: the URL is not trusted; the API decides ---------------------------------------

[ $ty, $ty_fake ] = cc_start();
$order60 = cc_order( 60, '100.00' );
$ty->process_payment( 60 );
$payment60 = (string) $order60->get_meta( CC_META_PAYMENT );
$ty_fake->set_payment( $payment60, array( 'status' => 'SETTLED', 'captured_at' => '2026-11-21T10:00:00Z' ) );
$ty->thankyou_page( 60 );
cc_same( 'return page completes a settled payment', 'processing', $order60->get_status() );
cc_same( 'return page marks the order paid once', 1, $order60->completions );
cc_check( 'return page asked the API for the payment by id', in_array( '/v1/payments/' . $payment60, array_column( $ty_fake->calls, 'path' ), true ) );

$order61 = cc_order( 61, '100.00' );
$ty->process_payment( 61 );
$ty->thankyou_page( 61 );
cc_same( 'return page leaves a pending payment alone', 'pending', $order61->get_status() );

$order62 = cc_order( 62, '100.00' );
$ty->process_payment( 62 );
$payment62 = (string) $order62->get_meta( CC_META_PAYMENT );
$ty_fake->set_payment( $payment62, array( 'order_id' => '999', 'status' => 'SETTLED', 'captured_at' => '2026-11-21T10:00:00Z' ) );
$ty->thankyou_page( 62 );
cc_same( 'return page does not complete an order the payment does not belong to', 'pending', $order62->get_status() );

$order63 = cc_order( 63, '100.00' );
$ty->process_payment( 63 );
$ty_fake->set_payment( (string) $order63->get_meta( CC_META_PAYMENT ), array( 'status' => 'SETTLED', 'captured_at' => '2026-11-21T10:00:00Z' ) );
$ty_fake->queue[] = 'network';
$ty->thankyou_page( 63 );
cc_same( 'return page survives an API failure and leaves the order to the webhook', 'pending', $order63->get_status() );

$order64 = cc_order( 64, '100.00' );
$ty->process_payment( 64 );
$ty_fake->set_payment( (string) $order64->get_meta( CC_META_PAYMENT ), array( 'status' => 'FAILED' ) );
$ty->thankyou_page( 64 );
cc_same( 'return page does not complete a failed payment', 'pending', $order64->get_status() );

$calls_before_done = count( $ty_fake->calls );
$order65           = cc_order( 65, '100.00', 'processing' );
$ty->thankyou_page( 65 );
cc_same( 'return page makes no API call for an order that is already paid', $calls_before_done, count( $ty_fake->calls ) );

// --- Connection test: GET /healthz and an authenticated call that is not /v1/me -----------------

[ $ct, $ct_fake ] = cc_start();
$api = new CardCrypto_Api( FakeCardCryptoApi::BASE, CC_SECRET_KEY );
$ok  = WC_Gateway_CardCrypto::check_connection( $api );
cc_check( 'connection test passes with the right key', true === ( $ok['ok'] ?? false ) && str_contains( $ok['message'], 'test mode' ) );
$paths = array_column( $ct_fake->calls, 'path' );
cc_check( 'connection test calls /healthz and an authenticated list endpoint', in_array( '/healthz', $paths, true ) && in_array( '/v1/payments?limit=1', $paths, true ) );
cc_check( 'connection test does not call /v1/me (dashboard-only, rejects API keys)', ! in_array( '/v1/me', $paths, true ) );

$ct_fake->queue[] = 'network';
$down = WC_Gateway_CardCrypto::check_connection( $api );
cc_check( 'connection test reports an unreachable API', false === $down['ok'] && str_contains( $down['message'], 'Could not reach' ) );

$wrong_key_fake                = new FakeCardCryptoApi( 'sk_test_OtherKey0123456789abcdefQQQ' );
$GLOBALS['cc']['transport']    = array( $wrong_key_fake, 'transport' );
$rejected                      = WC_Gateway_CardCrypto::check_connection( new CardCrypto_Api( FakeCardCryptoApi::BASE, CC_SECRET_KEY ) );
cc_check( 'connection test reports a rejected key without echoing it', false === $rejected['ok'] && str_contains( $rejected['message'], 'rejected' ) && ! str_contains( $rejected['message'], CC_SECRET_KEY ) );

// --- API client: error mapping, local validation, key modes -------------------------------------

$client_fake                = new FakeCardCryptoApi( CC_SECRET_KEY );
$GLOBALS['cc']['transport'] = array( $client_fake, 'transport' );
$client                     = new CardCrypto_Api( FakeCardCryptoApi::BASE, CC_SECRET_KEY );

$map_cases = array(
	array( 401, 'unauthorized', 'auth', true ),
	array( 404, 'not_found', 'not_found', true ),
	array( 409, 'payment_already_open', 'conflict', true ),
	array( 409, 'idempotency_in_progress', 'busy', false ),
	array( 422, 'idempotency_key_reused', 'invalid_request', true ),
	array( 429, 'rate_limited', 'rate_limited', false ),
	array( 503, 'provider_unavailable', 'server', false ),
);
foreach ( $map_cases as [ $status, $code, $category, $definitive ] ) {
	$client_fake->queue[] = array( 'status' => $status, 'body' => array( 'error' => array( 'type' => 'api_error', 'code' => $code, 'message' => 'x', 'request_id' => 'req_map' ) ) );
	try {
		$client->get_payment( 'pay_mapping000000000000001' );
		cc_check( "HTTP {$status}/{$code} maps to {$category}", false, 'no exception thrown' );
	} catch ( CardCrypto_Api_Exception $e ) {
		cc_same( "HTTP {$status}/{$code} maps to category {$category}", $category, $e->category );
		cc_same( "HTTP {$status}/{$code} is definitive: " . var_export( $definitive, true ), $definitive, $e->is_definitive() );
		cc_same( "HTTP {$status}/{$code} is transient: " . var_export( ! $definitive, true ), ! $definitive && ! in_array( $category, array( 'local' ), true ), $e->is_transient() );
	}
}

try {
	$client->create_payment( array( 'amount' => '1.00' ), 'short' );
	cc_check( 'a short Idempotency-Key is refused locally', false );
} catch ( CardCrypto_Api_Exception $e ) {
	cc_same( 'a short Idempotency-Key is refused locally', 'local', $e->category );
}

cc_same( 'mode is test for an sk_test_ key', 'test', CardCrypto_Api::mode_for_key( 'sk_test_x' ) );
cc_same( 'mode is live for an sk_live_ key', 'live', CardCrypto_Api::mode_for_key( 'sk_live_x' ) );
cc_same( 'mode is empty for an unknown prefix', '', CardCrypto_Api::mode_for_key( 'pk_x' ) );
cc_check( 'API client refuses a non-http base URL', cc_throws( static fn() => new CardCrypto_Api( 'ftp://api.example.com', CC_SECRET_KEY ) ) );

// --- Missing configuration fails cleanly -------------------------------------------------------

[ $nk, $nk_fake ] = cc_start( array( 'secret_key' => '' ) );
$order70          = cc_order( 70, '10.00' );
cc_same( 'no secret key: the payment fails with the generic notice', 'failure', $nk->process_payment( 70 )['result'] ?? null );
cc_same( 'no secret key: nothing is sent to the API', 0, count( $nk_fake->calls ) );

// --- Logs: nothing secret is written; debug entries respect the setting -----------------------

cc_check( 'redaction masks live and test keys and webhook secrets', 'key [redacted key] and [redacted secret]' === CardCrypto_Logger::redact( 'key sk_live_abc123XYZ and whsec_zzz123' ) );
cc_start( array( 'debug' => 'no' ) );
$quiet_before = count( $GLOBALS['cc']['logs'] );
CardCrypto_Logger::debug( 'should not appear' );
cc_same( 'debug entries are skipped when the debug setting is off', $quiet_before, count( $GLOBALS['cc']['logs'] ) );
CardCrypto_Logger::error( 'an error is always written' );
cc_same( 'errors are still written when debug is off', $quiet_before + 1, count( $GLOBALS['cc']['logs'] ) );

$log_text = cc_all_log_text();
cc_check( 'no log line contains the saved secret key', ! str_contains( $log_text, CC_SECRET_KEY ) && ! str_contains( $log_text, 'HarnessKey0123' ) );
cc_check( 'no log line contains the webhook secret', ! str_contains( $log_text, CC_WEBHOOK_SECRET ) && ! str_contains( $log_text, 'HarnessSecret' ) );
cc_check( 'no log line contains any key or secret prefix', ! str_contains( $log_text, 'sk_test_' ) && ! str_contains( $log_text, 'whsec_' ) );

exit( cc_finish() );
