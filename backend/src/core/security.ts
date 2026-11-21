import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import type { Mode } from './types.js';

// ---------------------------------------------------------------------------
// Identifiers and tokens
// ---------------------------------------------------------------------------

/** Prefixed, unguessable identifier, e.g. pay_3f9a…; prefix makes logs and support easier. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function uuid(): string {
  return randomUUID();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Constant-time string comparison (length is compared first, which is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Passwords (scrypt, memory-hard). Format: scrypt$N$r$p$salt$hash
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) return false;
  const actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Encryption at rest (AES-256-GCM). Payload format: v1.<iv>.<tag>.<ciphertext>
// ---------------------------------------------------------------------------

function loadKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
  return key;
}

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(keyBase64), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported encrypted payload.');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(keyBase64), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30 s step) with replay protection
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character.');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counterBuffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Verifies a 6-digit code within +/- `window` steps. Rejects codes at or before `lastUsedStep`. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { nowMs?: number; lastUsedStep?: number | null; window?: number } = {},
): { ok: boolean; step?: number } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const step = Math.floor((options.nowMs ?? Date.now()) / 30_000);
  const window = options.window ?? 1;
  for (let delta = -window; delta <= window; delta++) {
    const candidate = step + delta;
    if (options.lastUsedStep != null && candidate <= options.lastUsedStep) continue;
    if (safeEqual(totpCode(secretBase32, candidate), code)) return { ok: true, step: candidate };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Webhook signatures (outbound to merchants, and inbound from providers)
// Header: CardCrypto-Signature: t=<unix>,v1=<hex hmac sha256(secret, "<t>.<body>")>
// ---------------------------------------------------------------------------

export const WEBHOOK_SIGNATURE_HEADER = 'CardCrypto-Signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function signWebhookPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${hmacHex(secret, `${timestampSeconds}.${rawBody}`)}`;
}

export function verifyWebhookSignature(input: {
  header: string | undefined;
  rawBody: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): { ok: boolean; reason?: string } {
  if (!input.header) return { ok: false, reason: 'missing_signature' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value) timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (timestamp === null || !Number.isInteger(timestamp) || signatures.length === 0) {
    return { ok: false, reason: 'malformed_signature' };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  const expected = hmacHex(input.secret, `${timestamp}.${input.rawBody}`);
  return signatures.some((signature) => safeEqual(signature, expected))
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

// ---------------------------------------------------------------------------
// API keys: sk_<mode>_<16 hex key id>_<43 chars base64url secret>
// Only a keyed HMAC of the full token is stored (pepper lives in the environment).
// ---------------------------------------------------------------------------

const API_KEY_RE = /^(sk_(test|live)_[a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(mode: Mode): { token: string; keyPrefix: string } {
  const keyPrefix = `sk_${mode}_${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url');
  return { token: `${keyPrefix}_${secret}`, keyPrefix };
}

export function parseApiKey(token: string): { keyPrefix: string; mode: Mode } | null {
  const match = API_KEY_RE.exec(token);
  if (!match) return null;
  return { keyPrefix: match[1] ?? '', mode: match[2] === 'live' ? 'live' : 'test' };
}

export function hashApiKey(pepper: string, token: string): string {
  return hmacHex(pepper, token);
}

export function randomRefreshToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}
