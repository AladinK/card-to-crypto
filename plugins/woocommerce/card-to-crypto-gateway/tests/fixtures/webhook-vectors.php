<?php
/**
 * Webhook test vectors for the harness.
 *
 * Every "signature" is HMAC-SHA256 computed with the openssl CLI, not with the plugin:
 *   printf '%s.%s' "$timestamp" "$body" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}'
 * The secret is whsec_HarnessSecret_abcdefgh0123 and the bodies are the exact bytes sent to the handler.
 *
 * @package CardCryptoGateway
 */

return array(
	'captured_p1' => array(
		'timestamp' => 1767225600,
		'signature' => 'a588c73f6b9065b4deceb2d7052f435106336d8f074c0bd05190c8e9edc11183',
		'body'      => '{"id":"evt_h_0001","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:00:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","payment_method":"card"}}}',
	),
	'failed_p2' => array(
		'timestamp' => 1767225600,
		'signature' => '8f0030fdebe6051ac88b558b474a69798a7bcc8cb10facc3becd647c17823d50',
		'body'      => '{"id":"evt_h_0002","event":"payment.failed","api_version":"2026-11-01","created_at":"2026-01-01T00:00:00.000Z","mode":"test","livemode":false,"payment_id":"pay_1a2b3c4d5e6f7a8b9c0d1e2f","order_id":"43","fiat_amount":"20.00","fiat_currency":"EUR","status":"FAILED","reason":"card_declined","data":{"object":{"id":"pay_1a2b3c4d5e6f7a8b9c0d1e2f"}}}',
	),
	'cancelled_p3' => array(
		'timestamp' => 1767225600,
		'signature' => 'd396fe937feae10a9c7e7995c230c0ac7cb6341aa04c2eb5e452731df90809fb',
		'body'      => '{"id":"evt_h_0003","event":"payment.cancelled","api_version":"2026-11-01","created_at":"2026-01-01T00:00:00.000Z","mode":"test","livemode":false,"payment_id":"pay_2a2b3c4d5e6f7a8b9c0d2e3f","order_id":"44","fiat_amount":"30.00","fiat_currency":"EUR","status":"CANCELLED","reason":"checkout_expired","data":{"object":{"id":"pay_2a2b3c4d5e6f7a8b9c0d2e3f"}}}',
	),
	'settled_p1' => array(
		'timestamp' => 1767225600,
		'signature' => '3e06a69e1698c19617595aecfba5260331b0357cdbfe556a68a574771c1c6ac6',
		'body'      => '{"id":"evt_h_0004","event":"settlement.confirmed","api_version":"2026-11-01","created_at":"2026-01-01T00:05:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","crypto_asset":"USDC","crypto_amount":"98.765432","network":"polygon","wallet":"0x1111111111111111111111111111111111111111","tx_hash":"0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0","status":"confirmed","data":{"object":{"id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f"}}}',
	),
	'settle_failed_p1' => array(
		'timestamp' => 1767225600,
		'signature' => 'edc37805cbfbf57a78a5587339628e3ee53b3018ee17175c1cde57f1848b1fcc',
		'body'      => '{"id":"evt_h_0005","event":"settlement.failed","api_version":"2026-11-01","created_at":"2026-01-01T00:06:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","status":"FAILED","reason":"transfer_reverted","data":{"object":{"settlement_id":"stl_1"}}}',
	),
	'refund_ok_p1' => array(
		'timestamp' => 1767225600,
		'signature' => '591e071501a7800b846062f53e7b6d324a7e61c490d2600fe257e6ffbfcb9d6e',
		'body'      => '{"id":"evt_h_0006","event":"refund.completed","api_version":"2026-11-01","created_at":"2026-01-01T00:07:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","refund_id":"ref_0000000000000000000001","fiat_amount":"30.00","fiat_currency":"EUR","status":"REFUNDED","data":{"object":{"id":"ref_0000000000000000000001","status":"SUCCEEDED"}}}',
	),
	'refund_bad_p1' => array(
		'timestamp' => 1767225600,
		'signature' => 'fb59e07a8c620a031c7d825b2c26c8e628a1e6e0fa4776f91c29c4ed05f37ab8',
		'body'      => '{"id":"evt_h_0007","event":"refund.failed","api_version":"2026-11-01","created_at":"2026-01-01T00:08:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","refund_id":"ref_0000000000000000000002","status":"FAILED","data":{"object":{"id":"ref_0000000000000000000002","status":"FAILED"}}}',
	),
	'unknown_payment' => array(
		'timestamp' => 1767225600,
		'signature' => '178e4d686093a9073f60e9542331106d72ab3a34e0dbb5958418b24180132f3b',
		'body'      => '{"id":"evt_h_0008","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:09:00.000Z","mode":"test","livemode":false,"payment_id":"pay_9f9e8d7c6b5a4f3e2d1c0b9a","order_id":"999","fiat_amount":"5.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_9f9e8d7c6b5a4f3e2d1c0b9a"}}}',
	),
	'amount_mismatch_p5' => array(
		'timestamp' => 1767225600,
		'signature' => '2e92d7919e6aa018e0b0f40c4f4e0ff40c9af8cadb9a74d9adf22c6dd07540a5',
		'body'      => '{"id":"evt_h_0009","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:10:00.000Z","mode":"test","livemode":false,"payment_id":"pay_5a5a5a5a5a5a5a5a5a5a5a5a","order_id":"45","fiat_amount":"1.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_5a5a5a5a5a5a5a5a5a5a5a5a"}}}',
	),
	'livemode_p1' => array(
		'timestamp' => 1767225600,
		'signature' => '0bb29df6e7e7a2f3b00ebc10cd3a24c4040b7ec13c1b835b854adf3aba40a629',
		'body'      => '{"id":"evt_h_0010","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:11:00.000Z","mode":"live","livemode":true,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f"}}}',
	),
	'ignored_type_p1' => array(
		'timestamp' => 1767225600,
		'signature' => '1cf94bf00a3f9be0ee718f0d927722fb41ccaa1111134962f5564d40dfe287dc',
		'body'      => '{"id":"evt_h_0011","event":"conversion.completed","api_version":"2026-11-01","created_at":"2026-01-01T00:12:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","crypto_asset":"USDC","status":"CONVERSION_COMPLETED","data":{"object":{}}}',
	),
	'stale_captured_p1' => array(
		'timestamp' => 1767225299,
		'signature' => '9423cd83a96546ad2546c3790434dad86bca08ba2bad5c8e24fae5d21f1b2937',
		'body'      => '{"id":"evt_h_0012","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:13:00.000Z","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f"}}}',
	),
	'missing_id' => array(
		'timestamp' => 1767225600,
		'signature' => '7fb53a6dae38ea6f5374edebc34bdd5ded807b06eed0320dec45009040ba2136',
		'body'      => '{"event":"payment.captured","api_version":"2026-11-01","mode":"test","livemode":false,"payment_id":"pay_0a1b2c3d4e5f6a7b8c9d0e1f","order_id":"42","fiat_amount":"100.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED"}',
	),
	'not_json' => array(
		'timestamp' => 1767225600,
		'signature' => '6be7fab4fa0ce90b79f8ab1d3056823a72632521c8acefe78359fd55cc517c91',
		'body'      => 'not-json-at-all',
	),
	'captured_p2' => array(
		'timestamp' => 1767225600,
		'signature' => 'f6a3a54dc28f496b59b5d3a067776e5c975c369152e40c32a1c77d24c25d81c0',
		'body'      => '{"id":"evt_h_0013","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:14:00.000Z","mode":"test","livemode":false,"payment_id":"pay_1a2b3c4d5e6f7a8b9c0d1e2f","order_id":"43","fiat_amount":"20.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_1a2b3c4d5e6f7a8b9c0d1e2f"}}}',
	),
	'failed_p47' => array(
		'timestamp' => 1767225600,
		'signature' => '41489e21c8b90f8ff249c3d56bd99b2c90c09c887fc4e45535296beda96ff8a0',
		'body'      => '{"id":"evt_h_0014","event":"payment.failed","api_version":"2026-11-01","created_at":"2026-01-01T00:15:00.000Z","mode":"test","livemode":false,"payment_id":"pay_4747474747474747474747aa","order_id":"47","fiat_amount":"20.00","fiat_currency":"EUR","status":"FAILED","reason":"card_declined","data":{"object":{"id":"pay_4747474747474747474747aa"}}}',
	),
	'captured_p48' => array(
		'timestamp' => 1767225600,
		'signature' => '145d4b80b979fda476cbc39521d261e8079d574f2ee886dc9b8afc63957b1b4d',
		'body'      => '{"id":"evt_h_0015","event":"payment.captured","api_version":"2026-11-01","created_at":"2026-01-01T00:16:00.000Z","mode":"test","livemode":false,"payment_id":"pay_4848484848484848484848bb","order_id":"48","fiat_amount":"100.00","fiat_currency":"EUR","status":"PAYMENT_CAPTURED","data":{"object":{"id":"pay_4848484848484848484848bb"}}}',
	),
);
