import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
}

/**
 * Encrypts a Shopify access token. The shop domain is bound as additional authenticated data,
 * so a ciphertext copied to another shop's row fails to decrypt.
 * Output: v1.<iv>.<tag>.<ciphertext> (base64url segments).
 */
export function encryptToken(plaintext: string, shopDomain: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(shopDomain, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Throws a generic error for any malformed, tampered or mis-keyed payload. Never includes the plaintext. */
export function decryptToken(payload: string, shopDomain: string, key: Buffer): string {
  assertKey(key);
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('token payload is malformed');
  const [, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('token payload is malformed');
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(shopDomain, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('token decryption failed');
  }
}
