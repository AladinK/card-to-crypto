<?php
/**
 * Tests for CardCrypto_Signature. Plain PHP, no PHPUnit, no WordPress.
 *
 * Run: php tests/SignatureTest.php
 *
 * The expected signatures below were computed OUTSIDE the plugin with the openssl CLI:
 *   printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET"
 * (cross-checked with php's hash_hmac). The class under test is never used to produce them.
 */

define( 'ABSPATH', __DIR__ . '/' ); // Lets the class file run its "loaded by WordPress" guard.

require_once __DIR__ . '/../includes/class-cardcrypto-signature.php';
require_once __DIR__ . '/harness/assert.php';

run_signature_checks();

function run_signature_checks(): void {
	$secret  = 'whsec_TestSigningSecret_0123456789';
	$other   = 'whsec_OtherSecret_0123456789';
	$t       = 1767225600; // 2026-01-01T00:00:00Z
	$body    = '{"id":"evt_test_0001","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:00:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f"}}}';
	$tampered = str_replace( '"fiat_amount":"100.00"', '"fiat_amount":"900.00"', $body );

	// Vectors from openssl (see header comment).
	$sig_t          = '7a94e925522c843f74beff2638c570cabe9faf9cd9919974b4e428f52023026f'; // HMAC(secret, "T.body")
	$sig_t_plus_1   = '9e55a5d4e922246b1eac1fe8d17a3ac2e5fa1a300823bbd2434bb6b4eda42258'; // HMAC(secret, "(T+1).body")
	$sig_other      = 'ed3be3f5987ad46a9a4230e70339954410cafbc0a1a76290087907d577d7c299'; // HMAC(other, "T.body")
	$sig_tampered   = '5c617017c490dc5827bd29b3648d636b53702c896f1792e0b36e7b7d2b672c72'; // HMAC(secret, "T.tampered")

	$ok = static fn( ?string $header, string $raw, string $key, int $now, int $tol = 300 ): bool
		=> CardCrypto_Signature::verify( $header, $raw, $key, $now, $tol );

	$header = "t={$t},v1={$sig_t}";

	// Valid signature.
	cc_check( 'valid signature verifies at signing time', $ok( $header, $body, $secret, $t ) );

	// Tolerance window (inclusive at 300 seconds, rejected beyond it).
	cc_check( 'accepted exactly 300 s after signing', $ok( $header, $body, $secret, $t + 300 ) );
	cc_check( 'accepted exactly 300 s before signing (clock skew)', $ok( $header, $body, $secret, $t - 300 ) );
	cc_check( 'rejected 301 s after signing (stale / replay)', ! $ok( $header, $body, $secret, $t + 301 ) );
	cc_check( 'rejected 301 s before signing (future timestamp)', ! $ok( $header, $body, $secret, $t - 301 ) );
	cc_check( 'rejected an hour later (replay of a captured request)', ! $ok( $header, $body, $secret, $t + 3600 ) );
	cc_check( 'custom tolerance of 60 s rejects 61 s', ! $ok( $header, $body, $secret, $t + 61, 60 ) );
	cc_check( 'custom tolerance of 60 s accepts 60 s', $ok( $header, $body, $secret, $t + 60, 60 ) );
	cc_check( 'tolerance 0 accepts only the exact second', $ok( $header, $body, $secret, $t, 0 ) && ! $ok( $header, $body, $secret, $t + 1, 0 ) );

	// Tampering.
	cc_check( 'tampered body (amount changed) is rejected', ! $ok( $header, $tampered, $secret, $t ) );
	cc_check( 'original body with a signature made over the tampered body is rejected', ! $ok( "t={$t},v1={$sig_tampered}", $body, $secret, $t ) );
	cc_check( 'changing the timestamp without re-signing is rejected', ! $ok( 't=' . ( $t + 1 ) . ",v1={$sig_t}", $body, $secret, $t + 1 ) );
	cc_check( 'signature made with a different timestamp is accepted only with that timestamp', $ok( 't=' . ( $t + 1 ) . ",v1={$sig_t_plus_1}", $body, $secret, $t + 1 ) );
	cc_check( 'a signature from another secret is rejected', ! $ok( "t={$t},v1={$sig_other}", $body, $secret, $t ) );
	cc_check( 'a valid signature under the wrong secret is rejected', ! $ok( $header, $body, $other, $t ) );
	cc_check( 'body re-serialised with whitespace is rejected (raw bytes matter)', ! $ok( $header, str_replace( ',', ', ', $body ), $secret, $t ) );

	// Key rotation: any v1 value that matches is enough.
	cc_check( 'extra v1 value that does not match is ignored when another matches', $ok( "t={$t},v1={$sig_other},v1={$sig_t}", $body, $secret, $t ) );

	// Malformed headers.
	cc_check( 'null header is rejected', ! $ok( null, $body, $secret, $t ) );
	cc_check( 'empty header is rejected', ! $ok( '', $body, $secret, $t ) );
	cc_check( 'header without t is rejected', ! $ok( "v1={$sig_t}", $body, $secret, $t ) );
	cc_check( 'header without v1 is rejected', ! $ok( "t={$t}", $body, $secret, $t ) );
	cc_check( 'non-numeric t is rejected', ! $ok( "t=abc,v1={$sig_t}", $body, $secret, $t ) );
	cc_check( 'negative t is rejected', ! $ok( "t=-{$t},v1={$sig_t}", $body, $secret, $t ) );
	cc_check( 'duplicate t is rejected', ! $ok( "t={$t},t={$t},v1={$sig_t}", $body, $secret, $t ) );
	cc_check( 'uppercase hex in v1 is rejected', ! $ok( "t={$t},v1=" . strtoupper( $sig_t ), $body, $secret, $t ) );
	cc_check( 'truncated v1 is rejected', ! $ok( "t={$t},v1=" . substr( $sig_t, 0, 63 ), $body, $secret, $t ) );
	cc_check( 'empty v1 is rejected', ! $ok( "t={$t},v1=", $body, $secret, $t ) );
	cc_check( 'empty secret is rejected', ! $ok( $header, $body, '', $t ) );
	cc_check( 'negative tolerance is rejected', ! $ok( $header, $body, $secret, $t, -1 ) );

	// Lenient parsing that matches the backend: whitespace around parts, unknown keys, leading zeros.
	cc_check( 'whitespace after the comma is tolerated', $ok( "t={$t}, v1={$sig_t}", $body, $secret, $t ) );
	cc_check( 'unknown keys in the header are ignored', $ok( "t={$t},v0=ignored,v1={$sig_t}", $body, $secret, $t ) );
	cc_check( 'leading zeros in t (12 digits) are read as an integer, as the backend does', $ok( "t=00{$t},v1={$sig_t}", $body, $secret, $t ) );
	cc_check( 'a header with no equals sign in a part does not break parsing', $ok( "garbage,t={$t},v1={$sig_t}", $body, $secret, $t ) );

	// Digest form: HMAC output is lowercase hex, 64 characters.
	cc_check( 'expected digest is 64 lowercase hex characters', 1 === preg_match( '/^[a-f0-9]{64}$/', $sig_t ) );
}

exit( cc_finish() );
