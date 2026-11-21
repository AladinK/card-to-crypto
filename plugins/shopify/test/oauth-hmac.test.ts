import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildOAuthMessage, verifyOAuthCallback } from '../src/crypto/hmac.js';

// Independent vector, computed outside this code with OpenSSL:
//   MSG='code=abc123&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZGVtbw%3D%3D&shop=demo-store.myshopify.com&state=0123456789abcdef&timestamp=1700000000'
//   printf '%s' "$MSG" | openssl dgst -sha256 -hmac 'hush-test-secret-123'
const SECRET = 'hush-test-secret-123';
const SIGNED_MESSAGE =
  'code=abc123&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZGVtbw%3D%3D&shop=demo-store.myshopify.com&state=0123456789abcdef&timestamp=1700000000';
const EXPECTED_HEX = '56ad065c010e2ae992d4c8b78e6710f68bdefd9a5fe4e10bbd64783a0cee1d83';
const TIMESTAMP = 1700000000;

/** The callback query as the app receives it: `host` decodes to base64 with '=' padding. */
function callbackQuery(): URLSearchParams {
  const params = new URLSearchParams(SIGNED_MESSAGE);
  params.set('hmac', EXPECTED_HEX);
  params.set('signature', 'legacy-value-that-is-not-signed');
  return params;
}

describe('OAuth callback HMAC', () => {
  test('signed message is sorted, form-encoded and excludes hmac and signature', () => {
    assert.equal(buildOAuthMessage(callbackQuery()), SIGNED_MESSAGE);
  });

  test('accepts the independently computed OpenSSL vector', () => {
    assert.deepEqual(verifyOAuthCallback(callbackQuery(), SECRET, TIMESTAMP + 30), { ok: true });
  });

  test('accepts uppercase hex in the hmac parameter', () => {
    const params = callbackQuery();
    params.set('hmac', EXPECTED_HEX.toUpperCase());
    assert.deepEqual(verifyOAuthCallback(params, SECRET, TIMESTAMP), { ok: true });
  });

  test('a changed shop parameter fails', () => {
    const params = callbackQuery();
    params.set('shop', 'evil-store.myshopify.com');
    assert.deepEqual(verifyOAuthCallback(params, SECRET, TIMESTAMP), { ok: false, reason: 'invalid_hmac' });
  });

  test('a changed host value fails (dropping base64 padding changes the message)', () => {
    const params = callbackQuery();
    params.set('host', 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZGVtbw');
    assert.deepEqual(verifyOAuthCallback(params, SECRET, TIMESTAMP), { ok: false, reason: 'invalid_hmac' });
  });

  test('the signature parameter is ignored, so removing it does not change the result', () => {
    const params = callbackQuery();
    params.delete('signature');
    assert.deepEqual(verifyOAuthCallback(params, SECRET, TIMESTAMP), { ok: true });
  });

  test('a different API secret fails', () => {
    assert.deepEqual(verifyOAuthCallback(callbackQuery(), 'some-other-secret', TIMESTAMP), {
      ok: false,
      reason: 'invalid_hmac',
    });
  });

  test('a missing hmac fails', () => {
    const params = callbackQuery();
    params.delete('hmac');
    assert.deepEqual(verifyOAuthCallback(params, SECRET, TIMESTAMP), { ok: false, reason: 'missing_hmac' });
  });

  test('duplicated parameters are rejected instead of guessing how they were signed', () => {
    const params = callbackQuery();
    params.append('state', 'second-value');
    assert.deepEqual(verifyOAuthCallback(params, SECRET, TIMESTAMP), { ok: false, reason: 'duplicate_parameter' });
  });

  test('the timestamp must be within 90 seconds of now, on both sides', () => {
    assert.deepEqual(verifyOAuthCallback(callbackQuery(), SECRET, TIMESTAMP + 90), { ok: true });
    assert.deepEqual(verifyOAuthCallback(callbackQuery(), SECRET, TIMESTAMP + 91), {
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    assert.deepEqual(verifyOAuthCallback(callbackQuery(), SECRET, TIMESTAMP - 91), {
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });
});
