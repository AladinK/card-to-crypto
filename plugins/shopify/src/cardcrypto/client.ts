import { PermanentError, TransientError } from '../errors.js';
import { isRecord, type FetchFn } from '../types.js';
import { isHttpUrl } from '../util.js';

/** Body accepted by POST /v1/payments (backend/src/api/schemas.ts paymentBody, which is strict). */
export interface PaymentCreateBody {
  amount: string;
  currency: string;
  order_id: string;
  customer?: { email: string };
  description?: string;
  return_url: string;
  metadata?: Record<string, string>;
}

export interface CreatedPayment {
  id: string;
  status: string;
  checkoutUrl: string;
}

const PERMANENT_STATUSES = new Set([400, 402, 404, 405, 413, 415, 422]);

export function paymentsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/payments`;
}

/**
 * Creates a payment on the Card-to-Crypto backend. Idempotency-Key is required by the backend
 * (8-255 characters). Returns the payment id and checkout_url.
 */
export async function createPayment(
  deps: { fetch: FetchFn; timeoutMs: number },
  input: { baseUrl: string; apiKey: string; idempotencyKey: string; body: PaymentCreateBody },
): Promise<CreatedPayment> {
  let response: Response;
  try {
    response = await deps.fetch(paymentsUrl(input.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch {
    throw new TransientError('cardcrypto_unreachable');
  }

  if (!response.ok) {
    if (PERMANENT_STATUSES.has(response.status)) {
      throw new PermanentError('cardcrypto_rejected', `payment rejected with HTTP ${response.status}`);
    }
    throw new TransientError('cardcrypto_http_error', `payment request failed with HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TransientError('cardcrypto_invalid_json');
  }
  if (!isRecord(payload) || typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new TransientError('cardcrypto_invalid_response', 'response has no payment id');
  }
  if (!isHttpUrl(payload.checkout_url)) {
    throw new TransientError('cardcrypto_invalid_response', 'response has no usable checkout_url');
  }
  return {
    id: payload.id,
    status: typeof payload.status === 'string' ? payload.status : 'unknown',
    checkoutUrl: payload.checkout_url,
  };
}
