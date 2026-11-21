import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { decryptToken, encryptToken } from '../src/crypto/token-crypto.js';

const SHOP = 'demo-store.myshopify.com';
const TOKEN = `shpat_${'a1b2c3d4'.repeat(4)}`;

/** Flips one bit in the given base64url segment and re-encodes it. */
function tamperSegment(payload: string, index: number): string {
  const parts = payload.split('.');
  const bytes = Buffer.from(parts[index] ?? '', 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join('.');
}

describe('access token encryption (AES-256-GCM)', () => {
  const key = randomBytes(32);

  test('round trip returns the original token', () => {
    const payload = encryptToken(TOKEN, SHOP, key);
    assert.equal(decryptToken(payload, SHOP, key), TOKEN);
  });

  test('the stored form does not contain the plaintext and is versioned', () => {
    const payload = encryptToken(TOKEN, SHOP, key);
    assert.ok(payload.startsWith('v1.'));
    assert.equal(payload.includes(TOKEN), false);
    assert.equal(payload.includes('shpat_'), false);
  });

  test('each encryption uses a fresh IV, so equal tokens produce different payloads', () => {
    assert.notEqual(encryptToken(TOKEN, SHOP, key), encryptToken(TOKEN, SHOP, key));
  });

  test('tampering with the IV, the tag or the ciphertext is detected', () => {
    const payload = encryptToken(TOKEN, SHOP, key);
    for (const index of [1, 2, 3]) {
      assert.throws(() => decryptToken(tamperSegment(payload, index), SHOP, key), /token decryption failed|malformed/);
    }
  });

  test('a ciphertext copied to another shop does not decrypt (shop is bound as AAD)', () => {
    const payload = encryptToken(TOKEN, SHOP, key);
    assert.throws(() => decryptToken(payload, 'other-store.myshopify.com', key), /token decryption failed/);
  });

  test('a different key does not decrypt', () => {
    const payload = encryptToken(TOKEN, SHOP, key);
    assert.throws(() => decryptToken(payload, SHOP, randomBytes(32)), /token decryption failed/);
  });

  test('malformed payloads fail with a fixed message that does not echo the input', () => {
    for (const bad of ['', 'v2.aaaa.bbbb.cccc', 'v1.onlytwo.parts', 'v1.AAAA.BBBB.CCCC']) {
      assert.throws(() => decryptToken(bad, SHOP, key), { message: 'token payload is malformed' });
    }
  });

  test('keys must be exactly 32 bytes', () => {
    assert.throws(() => encryptToken(TOKEN, SHOP, randomBytes(16)), /32 bytes/);
    assert.throws(() => decryptToken('v1.a.b.c', SHOP, randomBytes(16)), /32 bytes/);
  });
});
