<?php
/**
 * Webhook checks against the TEST HARNESS. Bodies and signatures come from tests/fixtures/webhook-vectors.php,
 * which were produced with the openssl CLI, not with the plugin. This is not WordPress.
 *
 * Run: php tests/WebhookHarnessTest.php
 */

require_once __DIR__ . '/harness/bootstrap.php';

const CC_T = 1767225600; // Signing time used by every fixture.

$V = require __DIR__ . '/fixtures/webhook-vectors.php';

/** Header exactly as the backend sends it: t=<unix>,v1=<hex>. */
function wh_header( array $vector ): string {
	return 't=' . $vector['timestamp'] . ',v1=' . $vector['signature'];
}

/**
 * Fresh state: orders 42 (EUR 100.00), 43 (EUR 20.00), 44 (EUR 30.00) and 45 (EUR 50.00), each linked
 * to its own payment id. Each id appears in exactly one fixture family, so every check hits one order.
 *
 * @return array{0: WC_Order, 1: WC_Order, 2: WC_Order, 3: WC_Order, 4: FakeCardCryptoApi}
 */
function wh_setup(): array {
	[ , $fake ] = cc_start();

	$orders = array(
		42 => array( '100.00', 'pay_0a1b2c3d4e5f6a7b8c9d0e1f' ),
		43 => array( '20.00', 'pay_1a2b3c4d5e6f7a8b9c0d1e2f' ),
		44 => array( '30.00', 'pay_2a2b3c4d5e6f7a8b9c0d2e3f' ),
		45 => array( '50.00', 'pay_5a5a5a5a5a5a5a5a5a5a5a5a' ),
	);

	$made = array();
	foreach ( $orders as $id => [ $total, $payment_id ] ) {
		$order = cc_order( $id, $total );
		$order->update_meta_data( CC_META_PAYMENT, $payment_id );
		$made[] = $order;
	}

	return array( $made[0], $made[1], $made[2], $made[3], $fake );
}

$wh = new CardCrypto_Webhook( CC_WEBHOOK_SECRET, 'test' );

// --- Valid deliveries: completion, duplicates, on-hold -----------------------------------------------

[ $o42, , , , $fake ] = wh_setup();

$captured = $wh->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'valid payment.captured is acknowledged with 200', 200, $captured['status'] );
cc_same( 'valid payment.captured completes the order', 'processing', $o42->get_status() );
cc_same( 'the payment id becomes the transaction id', 'pay_0a1b2c3d4e5f6a7b8c9d0e1f', $o42->get_transaction_id() );
cc_check( 'completion note names the payment id', str_contains( cc_notes( $o42 ), 'pay_0a1b2c3d4e5f6a7b8c9d0e1f' ) );

$again = $wh->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'the same event id is acknowledged as a duplicate', 'duplicate', $again['body']['reason'] ?? null );
cc_same( 'the duplicate does not complete the order twice', 1, $o42->completions );

$after_restart = ( new CardCrypto_Webhook( CC_WEBHOOK_SECRET, 'test' ) )->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'duplicate detection uses the stored event ids (new handler instance)', 'duplicate', $after_restart['body']['reason'] ?? null );

[ , $h43 ] = wh_setup();
$h43->update_status( 'on-hold' );
$wh->process( $V['captured_p2']['body'], wh_header( $V['captured_p2'] ), CC_T );
cc_same( 'a capture completes an on-hold order', 'processing', $h43->get_status() );

// --- Signature, freshness and body checks ----------------------------------------------------------------

[ $s42, , , , $sig_fake ] = wh_setup();

$tampered = str_replace( '"fiat_amount":"100.00"', '"fiat_amount":"900.00"', $V['captured_p1']['body'] );
$bad      = $wh->process( $tampered, wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'tampered body is rejected with 400', 400, $bad['status'] );
cc_same( 'tampered body reason is invalid_signature', 'invalid_signature', $bad['body']['reason'] ?? null );
cc_same( 'tampered body changes nothing', 'pending', $s42->get_status() );

$wrong_secret = ( new CardCrypto_Webhook( 'whsec_OtherSecret_0123456789', 'test' ) )->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'a signature from another secret is rejected', 400, $wrong_secret['status'] );

$stale = $wh->process( $V['stale_captured_p1']['body'], wh_header( $V['stale_captured_p1'] ), CC_T );
cc_same( 'a delivery 301 seconds old is rejected as a replay', 400, $stale['status'] );
cc_same( 'the stale delivery changes nothing', 'pending', $s42->get_status() );

cc_same( 'a missing signature header is rejected', 400, $wh->process( $V['captured_p1']['body'], null, CC_T )['status'] );
cc_same( 'an empty body is rejected', 400, $wh->process( '', wh_header( $V['captured_p1'] ), CC_T )['status'] );
cc_same( 'a signed body without an id is rejected', 400, $wh->process( $V['missing_id']['body'], wh_header( $V['missing_id'] ), CC_T )['status'] );
cc_same( 'a signed body that is not JSON is rejected', 400, $wh->process( $V['not_json']['body'], wh_header( $V['not_json'] ), CC_T )['status'] );
cc_same( 'rejected deliveries never send anything to the API', 0, count( $sig_fake->calls ) );

// --- Event handling -------------------------------------------------------------------------------------

[ $e42, $e43, $e44, $e45 ] = wh_setup();

$unknown = $wh->process( $V['unknown_payment']['body'], wh_header( $V['unknown_payment'] ), CC_T );
cc_same( 'a capture for an unlinked payment is acknowledged with 200', 200, $unknown['status'] );
cc_check( 'an unlinked payment changes no linked order', 'pending' === $e42->get_status() && 'pending' === $e43->get_status() && 'pending' === $e44->get_status() && 'pending' === $e45->get_status() );

$mismatch = $wh->process( $V['amount_mismatch_p5']['body'], wh_header( $V['amount_mismatch_p5'] ), CC_T );
cc_same( 'a capture with another amount is acknowledged', 200, $mismatch['status'] );
cc_same( 'a capture with another amount does not complete the order', 'pending', $e45->get_status() );
cc_check( 'a capture with another amount leaves a note for review', str_contains( cc_notes( $e45 ), 'does not match this order' ) );

$livemode = $wh->process( $V['livemode_p1']['body'], wh_header( $V['livemode_p1'] ), CC_T );
cc_same( 'a live-mode event on a test-mode handler is acknowledged and ignored', 'ignored_mode_mismatch', $livemode['body']['reason'] ?? null );
cc_same( 'a live-mode event changes nothing', 'pending', $e42->get_status() );

$settled = $wh->process( $V['settled_p1']['body'], wh_header( $V['settled_p1'] ), CC_T );
cc_same( 'settlement.confirmed is acknowledged', 200, $settled['status'] );
cc_same( 'settlement.confirmed keeps the order status', 'pending', $e42->get_status() );
cc_check( 'settlement note carries the network and the transaction hash', str_contains( cc_notes( $e42 ), 'polygon' ) && str_contains( cc_notes( $e42 ), '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0' ) );
cc_check( 'settlement note names the asset and the crypto amount', str_contains( cc_notes( $e42 ), 'USDC' ) && str_contains( cc_notes( $e42 ), '98.765432' ) );

$settle_failed = $wh->process( $V['settle_failed_p1']['body'], wh_header( $V['settle_failed_p1'] ), CC_T );
cc_same( 'settlement.failed is acknowledged', 200, $settle_failed['status'] );
cc_check( 'settlement.failed leaves an action-required note', str_contains( cc_notes( $e42 ), 'ACTION REQUIRED' ) );
cc_same( 'settlement.failed keeps the order status', 'pending', $e42->get_status() );

$refund_ok = $wh->process( $V['refund_ok_p1']['body'], wh_header( $V['refund_ok_p1'] ), CC_T );
cc_same( 'refund.completed is acknowledged', 200, $refund_ok['status'] );
cc_check( 'refund.completed adds a note with the refund id and amount', str_contains( cc_notes( $e42 ), 'ref_0000000000000000000001 completed: 30.00 EUR' ) );

$refund_bad = $wh->process( $V['refund_bad_p1']['body'], wh_header( $V['refund_bad_p1'] ), CC_T );
cc_same( 'refund.failed is acknowledged', 200, $refund_bad['status'] );
cc_check( 'refund.failed adds a note', str_contains( cc_notes( $e42 ), 'ref_0000000000000000000002 failed' ) );
cc_same( 'refund events never change the order status', 'pending', $e42->get_status() );

$failed = $wh->process( $V['failed_p2']['body'], wh_header( $V['failed_p2'] ), CC_T );
cc_same( 'payment.failed moves a pending order to failed', 'failed', $e43->get_status() );
cc_check( 'payment.failed note carries the reason', str_contains( cc_notes( $e43 ), 'card_declined' ) );

$cancelled = $wh->process( $V['cancelled_p3']['body'], wh_header( $V['cancelled_p3'] ), CC_T );
cc_same( 'payment.cancelled moves a pending order to cancelled', 'cancelled', $e44->get_status() );

$wh_ignored = $wh->process( $V['ignored_type_p1']['body'], wh_header( $V['ignored_type_p1'] ), CC_T );
cc_same( 'an event type with no handler is acknowledged with 200', 200, $wh_ignored['status'] );
cc_same( 'an event type with no handler changes nothing', 'pending', $e42->get_status() );

$processing_47 = cc_order( 47, '20.00', 'processing' );
$processing_47->update_meta_data( CC_META_PAYMENT, 'pay_4747474747474747474747aa' );
$wh->process( $V['failed_p47']['body'], wh_header( $V['failed_p47'] ), CC_T );
cc_same( 'payment.failed does not touch an order that is already processing', 'processing', $processing_47->get_status() );

$cancelled_48 = cc_order( 48, '100.00', 'cancelled' );
$cancelled_48->update_meta_data( CC_META_PAYMENT, 'pay_4848484848484848484848bb' );
$wh->process( $V['captured_p48']['body'], wh_header( $V['captured_p48'] ), CC_T );
cc_same( 'a capture for a cancelled order is noted, not completed', 'cancelled', $cancelled_48->get_status() );
cc_check( 'that capture is noted for the merchant', str_contains( cc_notes( $cancelled_48 ), 'while this order is cancelled' ) );

// --- Retries, configuration and the bounded event memory ---------------------------------------------

[ $r42 ] = wh_setup();
$GLOBALS['cc']['fail_order_query'] = true;
$crash = $wh->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'an internal error returns 500 so the backend retries', 500, $crash['status'] );
cc_same( 'the internal error leaves the order unchanged', 'pending', $r42->get_status() );
$GLOBALS['cc']['fail_order_query'] = false;

$retry = $wh->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'the retry is processed in full (the failed attempt was not remembered)', 200, $retry['status'] );
cc_same( 'the retry completes the order', 'processing', $r42->get_status() );

$unset_secret = ( new CardCrypto_Webhook( '', 'test' ) )->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
cc_same( 'no saved webhook secret returns 500 (configuration error, retried)', 500, $unset_secret['status'] );

[ , , , , $bounded_fake ] = wh_setup();
$old_ids = array();
for ( $i = 0; $i < 500; $i++ ) {
	$old_ids[] = 'evt_old_' . $i;
}
update_option( CardCrypto_Webhook::OPTION_EVENTS, $old_ids, false );
$bounded = $wh->process( $V['captured_p1']['body'], wh_header( $V['captured_p1'] ), CC_T );
$stored  = get_option( CardCrypto_Webhook::OPTION_EVENTS, array() );
cc_same( 'the remembered event list is capped at 500 entries', 500, count( $stored ) );
cc_check( 'the oldest remembered id is dropped first', ! in_array( 'evt_old_0', $stored, true ) && in_array( 'evt_h_0001', $stored, true ) );
cc_same( 'the capped list still records the new event', 200, $bounded['status'] );
cc_same( 'webhook processing makes no API calls', 0, count( $bounded_fake->calls ) );

// --- Logs written by the webhook carry no secrets ----------------------------------------------------

$log_text = cc_all_log_text();
cc_check( 'webhook logs do not contain the webhook secret', ! str_contains( $log_text, CC_WEBHOOK_SECRET ) && ! str_contains( $log_text, 'HarnessSecret' ) );

exit( cc_finish() );
