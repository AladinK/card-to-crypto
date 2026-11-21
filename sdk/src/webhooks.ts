import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'CardCrypto-Signature';

export interface VerifyWebhookInput {
  /** Value of the CardCrypto-Signature header. */
  signatureHeader: string | undefined;
  /** The exact raw request body bytes or string, before JSON parsing. */
  rawBody: string | Uint8Array;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/**
 * Verifies a CardCrypto webhook. Throws on failure so a forgotten `if` cannot accept a forged event.
 * Returns the parsed event on success.
 */
export function verifyWebhook<T = Record<string, unknown>>(input: VerifyWebhookInput): T {
  const header = input.signatureHeader;
  if (!header) throw new Error('Missing CardCrypto-Signature header.');
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value) timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (timestamp === undefined || !Number.isInteger(timestamp) || signatures.length === 0) {
    throw new Error('Malformed CardCrypto-Signature header.');
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) {
    throw new Error('Webhook timestamp is outside the tolerance window (possible replay).');
  }
  const body = typeof input.rawBody === 'string' ? input.rawBody : Buffer.from(input.rawBody).toString('utf8');
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${body}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const valid = signatures.some((signature) => {
    const candidate = Buffer.from(signature);
    return candidate.length === expectedBuf.length && timingSafeEqual(candidate, expectedBuf);
  });
  if (!valid) throw new Error('Invalid CardCrypto webhook signature.');
  return JSON.parse(body) as T;
}
