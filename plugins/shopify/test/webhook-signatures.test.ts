import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verifyCardCryptoSignature, verifyShopifyWebhookHmac } from '../src/crypto/hmac.js';

// Shopify vector, computed with OpenSSL:
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'shpss-test-0123' -binary | base64
const SHOP_SECRET = 'shpss-test-0123';
const SHOP_BODY = '{"id":820982911946154500,"name":"#1001","total_price":"100.00","currency":"EUR"}';
const SHOP_HMAC = 'RfWfj6B1SuNedO354pe7sm70xwmeYKypntQuNwB3LY0=';

// CardCrypto vector, computed with OpenSSL:
//   printf '%s.%s' 1700000000 "$BODY" | openssl dgst -sha256 -hmac 'cc-whsec-test-0123456789'
const CC_SECRET = 'cc-whsec-test-0123456789';
const CC_BODY = '{"id":"evt_test_1","event":"payment.captured","payment_id":"pay_test_1"}';
const CC_T = 1700000000;
const CC_V1 = 'aa06312326489e500aa792238e9e31f8a9e146e3c0e92a74a7064952fd639c7e';

describe('Shopify webhook HMAC (base64 over the raw body)', () => {
  test('accepts the OpenSSL vector over the exact bytes', () => {
    assert.equal(verifyShopifyWebhookHmac(Buffer.from(SHOP_BODY), SHOP_HMAC, SHOP_SECRET), true);
  });

  test('rejects a body that differs by one character', () => {
    const tampered = Buffer.from(SHOP_BODY.replace('100.00', '100.01'));
    assert.equal(verifyShopifyWebhookHmac(tampered, SHOP_HMAC, SHOP_SECRET), false);
  });

  test('rejects a re-serialized body (same JSON, different bytes)', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(SHOP_BODY), null, 2));
    assert.equal(verifyShopifyWebhookHmac(reserialized, SHOP_HMAC, SHOP_SECRET), false);
  });

  test('rejects a wrong secret', () => {
    assert.equal(verifyShopifyWebhookHmac(Buffer.from(SHOP_BODY), SHOP_HMAC, 'not-the-secret'), false);
  });

  test('rejects a missing or empty header', () => {
    assert.equal(verifyShopifyWebhookHmac(Buffer.from(SHOP_BODY), undefined, SHOP_SECRET), false);
    assert.equal(verifyShopifyWebhookHmac(Buffer.from(SHOP_BODY), '', SHOP_SECRET), false);
  });

  test('rejects the hex encoding of the right digest (base64 is required)', () => {
    const hex = Buffer.from(SHOP_HMAC, 'base64').toString('hex');
    assert.equal(verifyShopifyWebhookHmac(Buffer.from(SHOP_BODY), hex, SHOP_SECRET), false);
  });
});

describe('CardCrypto-Signature (t=<unix>,v1=<hex> over "<t>.<body>")', () => {
  const header = `t=${CC_T},v1=${CC_V1}`;

  test('accepts the OpenSSL vector at the signed timestamp', () => {
    assert.deepEqual(
      verifyCardCryptoSignature({ header, rawBody: Buffer.from(CC_BODY), secret: CC_SECRET, nowSeconds: CC_T }),
      { ok: true },
    );
  });

  test('replay window: accepted at exactly 300 seconds either way, rejected beyond', () => {
    const check = (nowSeconds: number) =>
      verifyCardCryptoSignature({ header, rawBody: Buffer.from(CC_BODY), secret: CC_SECRET, nowSeconds });
    assert.deepEqual(check(CC_T + 300), { ok: true });
    assert.deepEqual(check(CC_T - 300), { ok: true });
    assert.deepEqual(check(CC_T + 301), { ok: false, reason: 'timestamp_out_of_tolerance' });
    assert.deepEqual(check(CC_T - 301), { ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  test('a changed timestamp breaks the signature even inside the window', () => {
    const shifted = `t=${CC_T + 1},v1=${CC_V1}`;
    assert.deepEqual(
      verifyCardCryptoSignature({ header: shifted, rawBody: Buffer.from(CC_BODY), secret: CC_SECRET, nowSeconds: CC_T + 1 }),
      { ok: false, reason: 'signature_mismatch' },
    );
  });

  test('a tampered body fails', () => {
    const tampered = Buffer.from(CC_BODY.replace('pay_test_1', 'pay_test_2'));
    assert.deepEqual(
      verifyCardCryptoSignature({ header, rawBody: tampered, secret: CC_SECRET, nowSeconds: CC_T }),
      { ok: false, reason: 'signature_mismatch' },
    );
  });

  test('a wrong secret fails', () => {
    assert.deepEqual(
      verifyCardCryptoSignature({ header, rawBody: Buffer.from(CC_BODY), secret: 'other-secret-value', nowSeconds: CC_T }),
      { ok: false, reason: 'signature_mismatch' },
    );
  });

  test('accepts when one of several v1 signatures matches (secret rotation)', () => {
    const rotated = `t=${CC_T},v1=${'0'.repeat(64)},v1=${CC_V1}`;
    assert.deepEqual(
      verifyCardCryptoSignature({ header: rotated, rawBody: Buffer.from(CC_BODY), secret: CC_SECRET, nowSeconds: CC_T }),
      { ok: true },
    );
  });

  test('malformed or missing headers are rejected', () => {
    const run = (value: string | undefined) =>
      verifyCardCryptoSignature({ header: value, rawBody: Buffer.from(CC_BODY), secret: CC_SECRET, nowSeconds: CC_T });
    assert.deepEqual(run(undefined), { ok: false, reason: 'missing_signature' });
    assert.deepEqual(run(''), { ok: false, reason: 'missing_signature' });
    assert.deepEqual(run(',,'), { ok: false, reason: 'malformed_signature' });
    assert.deepEqual(run(`t=${CC_T}`), { ok: false, reason: 'malformed_signature' });
    assert.deepEqual(run(`v1=${CC_V1}`), { ok: false, reason: 'malformed_signature' });
    assert.deepEqual(run(`t=abc,v1=${CC_V1}`), { ok: false, reason: 'malformed_signature' });
    assert.deepEqual(run(`t=${CC_T},v1=XYZ`), { ok: false, reason: 'malformed_signature' });
  });
});
