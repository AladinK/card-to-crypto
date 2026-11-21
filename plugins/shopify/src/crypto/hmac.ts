import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

const OK: VerifyResult = { ok: true };
const fail = (reason: string): VerifyResult => ({ ok: false, reason });

/** Constant-time comparison of two strings (lengths are not secret). */
export function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Shopify's OAuth callback HMAC tolerates clock skew of this many seconds (matches @shopify/shopify-api). */
export const OAUTH_TIMESTAMP_TOLERANCE_SECONDS = 90;

/**
 * The signed message for an OAuth callback: every query parameter except `hmac` and `signature`,
 * sorted by key, with values form-encoded (the same encoding @shopify/shopify-api applies) and
 * joined with `&`. Parameters are read after URL decoding, so `%3D` in the raw query becomes `=`
 * before it is re-encoded.
 */
export function buildOAuthMessage(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of params) {
    if (key === 'hmac' || key === 'signature') continue;
    pairs.push([key, value]);
  }
  pairs.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    if (aValue === bValue) return 0;
    return aValue < bValue ? -1 : 1;
  });
  const encoded = new URLSearchParams();
  for (const [key, value] of pairs) encoded.append(key, value);
  return encoded.toString().replace(/\+/g, '%20');
}

/** Verifies the hex HMAC-SHA256 (keyed with the app's API secret) on an OAuth callback query. */
export function verifyOAuthCallback(params: URLSearchParams, apiSecret: string, nowSeconds: number): VerifyResult {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return fail('duplicate_parameter');

  const hmac = params.get('hmac');
  if (!hmac) return fail('missing_hmac');

  const timestamp = params.get('timestamp');
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return fail('invalid_timestamp');
  if (Math.abs(nowSeconds - Number(timestamp)) > OAUTH_TIMESTAMP_TOLERANCE_SECONDS) {
    return fail('timestamp_out_of_tolerance');
  }

  const expected = createHmac('sha256', apiSecret).update(buildOAuthMessage(params), 'utf8').digest('hex');
  return safeEqualText(hmac.toLowerCase(), expected) ? OK : fail('invalid_hmac');
}

/**
 * Shopify webhook signature: base64(HMAC-SHA256(apiSecret, rawBody)) in X-Shopify-Hmac-Sha256.
 * Must run on the raw bytes, before any JSON parsing.
 */
export function verifyShopifyWebhookHmac(rawBody: Buffer, headerValue: string | undefined, apiSecret: string): boolean {
  if (!headerValue) return false;
  const expected = createHmac('sha256', apiSecret).update(rawBody).digest('base64');
  return safeEqualText(headerValue.trim(), expected);
}

/** Tolerance for CardCrypto webhook timestamps, same as the backend's WEBHOOK_TOLERANCE_SECONDS. */
export const CARDCRYPTO_TOLERANCE_SECONDS = 300;

/**
 * CardCrypto-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]. Each v1 is HMAC-SHA256(secret, "<t>.<rawBody>").
 * Accepts when any v1 matches and |now - t| <= 300 seconds.
 */
export function verifyCardCryptoSignature(input: {
  header: string | undefined;
  rawBody: Buffer;
  secret: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): VerifyResult {
  if (!input.header) return fail('missing_signature');

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return fail('malformed_signature');

  const tolerance = input.toleranceSeconds ?? CARDCRYPTO_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return fail('timestamp_out_of_tolerance');

  const mac = createHmac('sha256', input.secret);
  mac.update(`${timestamp}.`);
  mac.update(input.rawBody);
  const expected = mac.digest('hex');

  let matched = false;
  for (const signature of signatures) {
    if (safeEqualText(signature, expected)) matched = true;
  }
  return matched ? OK : fail('signature_mismatch');
}

/** Value stored in the OAuth state cookie: `<state>.<hmac(shop|state)>`. The shop binds the cookie to one install. */
export function signOAuthState(shop: string, state: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(`${shop}|${state}`).digest('hex');
  return `${state}.${mac}`;
}

/** Returns the state if the cookie is authentic for this shop, otherwise null. */
export function readOAuthStateCookie(cookieValue: string | undefined, shop: string, secret: string): string | null {
  if (!cookieValue) return null;
  const separator = cookieValue.lastIndexOf('.');
  if (separator <= 0) return null;
  const state = cookieValue.slice(0, separator);
  return safeEqualText(signOAuthState(shop, state, secret), cookieValue) ? state : null;
}
