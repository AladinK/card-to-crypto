<?php
/**
 * Admin-screen checks against the TEST HARNESS: settings page output, the connection-test notice,
 * and the admin-post handler. This is not WordPress. The handler calls exit(), so it runs last.
 *
 * Run: php tests/AdminHarnessTest.php
 */

require_once __DIR__ . '/harness/bootstrap.php';

// --- Settings page: webhook URL and the test link, and no secret in the output --------------------

[ $gw, $fake ] = cc_start();

ob_start();
$gw->admin_options();
$page = (string) ob_get_clean();

cc_check( 'settings page shows the webhook URL for the store', str_contains( $page, 'https://shop.example/wp-json/card-to-crypto/v1/webhook' ) );
cc_check( 'settings page links to the connection test with a nonce', str_contains( $page, 'admin-post.php?action=cardcrypto_test_connection&amp;_wpnonce=test-nonce' ) || str_contains( $page, 'admin-post.php?action=cardcrypto_test_connection&_wpnonce=test-nonce' ) );
cc_check( 'settings page never prints the saved secret key', ! str_contains( $page, CC_SECRET_KEY ) );
cc_check( 'settings page never prints the webhook secret', ! str_contains( $page, CC_WEBHOOK_SECRET ) );

// --- Connection-test notice: shown once, then removed --------------------------------------------

set_transient( 'cardcrypto_test_result_1', array( 'ok' => true, 'message' => 'Connection OK. The API accepted the secret key (test mode).' ), 120 );
$_GET = array( 'section' => 'cardcrypto', 'cardcrypto_test' => '1' );

ob_start();
WC_Gateway_CardCrypto::render_test_notice();
$notice = (string) ob_get_clean();
cc_check( 'a successful test shows a success notice', str_contains( $notice, 'notice-success' ) && str_contains( $notice, 'test mode' ) );
cc_check( 'the notice is removed after it is shown once', false === get_transient( 'cardcrypto_test_result_1' ) );

set_transient( 'cardcrypto_test_result_1', array( 'ok' => false, 'message' => 'Could not reach the API. <script>x</script>' ), 120 );
ob_start();
WC_Gateway_CardCrypto::render_test_notice();
$failed_notice = (string) ob_get_clean();
cc_check( 'a failed test shows an error notice', str_contains( $failed_notice, 'notice-error' ) );
cc_check( 'notice text is escaped', ! str_contains( $failed_notice, '<script>' ) && str_contains( $failed_notice, '&lt;script&gt;' ) );

$_GET = array( 'section' => 'paypal', 'cardcrypto_test' => '1' );
set_transient( 'cardcrypto_test_result_1', array( 'ok' => true, 'message' => 'x' ), 120 );
ob_start();
WC_Gateway_CardCrypto::render_test_notice();
cc_check( 'the notice is not shown on other settings screens', '' === (string) ob_get_clean() );
$_GET = array();

// --- Connection-test failure messages are specific and never echo the key ----------------------

[ , $auth_fake ] = cc_start();
$auth_fake->queue[] = array( 'status' => 500, 'body' => array( 'error' => array( 'type' => 'api_error', 'code' => 'internal', 'message' => 'boom', 'request_id' => 'req_x' ) ) );
$server_down = WC_Gateway_CardCrypto::check_connection( new CardCrypto_Api( FakeCardCryptoApi::BASE, CC_SECRET_KEY ) );
cc_check( 'a 500 from the health check reports the HTTP status', false === $server_down['ok'] && str_contains( $server_down['message'], 'HTTP 500' ) );

[ , $unhealthy ] = cc_start();
$unhealthy->queue[] = array( 'status' => 200, 'body' => array( 'status' => 'degraded' ) );
$odd = WC_Gateway_CardCrypto::check_connection( new CardCrypto_Api( FakeCardCryptoApi::BASE, CC_SECRET_KEY ) );
cc_check( 'an unexpected health payload fails the test', false === $odd['ok'] );

// --- Admin-post handler: runs last, because it calls exit() -----------------------------------------

[ , $post_fake ] = cc_start();
$GLOBALS['cc']['redirects'] = array();

register_shutdown_function(
	static function () use ( $post_fake ): void {
		$redirect = $GLOBALS['cc']['redirects'][0] ?? '';
		$result   = get_transient( 'cardcrypto_test_result_1' );

		cc_check( 'the admin-post handler redirects back to the gateway settings', str_contains( $redirect, 'section=cardcrypto' ) && str_contains( $redirect, 'cardcrypto_test=1' ) );
		cc_check( 'the admin-post handler stores a successful result for the notice', is_array( $result ) && true === ( $result['ok'] ?? false ) );
		cc_check( 'the admin-post handler used /healthz and the key-check list, never /v1/me', false === in_array( '/v1/me', array_column( $post_fake->calls, 'path' ), true ) && in_array( '/healthz', array_column( $post_fake->calls, 'path' ), true ) );

		exit( cc_finish() );
	}
);

WC_Gateway_CardCrypto::handle_test_connection();

// Not reached: handle_test_connection() ends the script with exit().
echo "handler returned unexpectedly\n";
exit( 1 );
