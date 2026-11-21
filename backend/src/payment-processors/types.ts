import type { FiatCurrency } from '../core/money.js';
import type { Mode } from '../core/types.js';

/**
 * Payment provider abstraction. Adapters: Stripe (live), sandbox (test).
 * Adding Adyen, Checkout.com or PayPal means implementing this interface, nothing else.
 * Raw card data never reaches this layer: providers use hosted checkout / tokenization.
 */
export interface CreateProviderPaymentInput {
  paymentId: string;
  mode: Mode;
  amountMinor: bigint;
  currency: FiatCurrency;
  description: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  metadata: Record<string, string>;
}

export interface CreateProviderPaymentResult {
  providerSessionId: string;
  checkoutUrl: string;
}

export type ProviderPaymentState = 'pending' | 'authorized' | 'captured' | 'failed' | 'cancelled';

export interface ProviderPaymentStatus {
  state: ProviderPaymentState;
  providerPaymentId: string | null;
  amountMinor: bigint | null;
  currency: FiatCurrency | null;
  paymentMethod: string | null;
  cardCountry: string | null;
}

/** Provider-neutral events. The payment engine only ever sees these. */
export type NormalizedProviderEvent =
  | {
      kind: 'payment.authorized' | 'payment.captured' | 'payment.failed' | 'payment.cancelled';
      eventId: string;
      paymentId: string;
      providerSessionId: string | null;
      providerPaymentId: string | null;
      amountMinor: bigint | null;
      currency: FiatCurrency | null;
      paymentMethod: string | null;
      cardCountry: string | null;
      reason: string | null;
    }
  | {
      kind: 'refund.succeeded' | 'refund.failed';
      eventId: string;
      refundId: string;
      providerRefundId: string;
      providerPaymentId: string | null;
      amountMinor: bigint;
      currency: FiatCurrency;
      reason: string | null;
    }
  | { kind: 'ignored'; eventId: string; type: string };

export interface RefundResult {
  providerRefundId: string;
  state: 'pending' | 'succeeded' | 'failed';
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: Mode;
  createPayment(input: CreateProviderPaymentInput): Promise<CreateProviderPaymentResult>;
  /** Read-only lookup, used for reconciliation when a webhook is delayed or lost. */
  getPaymentStatus(ref: { providerPaymentId: string | null; providerSessionId: string | null; paymentId: string }): Promise<ProviderPaymentStatus>;
  /** Captures a previously authorized amount (manual-capture flow). Idempotent per key. */
  capturePayment(input: { providerPaymentId: string; amountMinor: bigint; idempotencyKey: string }): Promise<{ state: 'captured' }>;
  /** Releases an authorization that will not be captured. Idempotent per key. */
  cancelPayment(input: { providerPaymentId: string; idempotencyKey: string }): Promise<void>;
  refundPayment(input: {
    providerPaymentId: string;
    amountMinor: bigint;
    refundId: string;
    reason: 'requested_by_customer' | 'duplicate' | 'fraudulent' | 'other';
  }): Promise<RefundResult>;
  /** Verifies the provider signature and maps the payload. Throws on invalid signatures. */
  handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedProviderEvent[];
}

/** Payment-level events (the refund variants carry no payment id). */
export type PaymentProviderEvent = Extract<NormalizedProviderEvent, { paymentId: string }>;
