import Stripe from 'stripe';
import { AppError } from '../core/errors.js';
import { isFiatCurrency, type FiatCurrency } from '../core/money.js';
import type {
  CreateProviderPaymentInput,
  CreateProviderPaymentResult,
  NormalizedProviderEvent,
  PaymentProvider,
  ProviderPaymentStatus,
  RefundResult,
} from './types.js';

export interface StripeProviderOptions {
  secretKey: string;
  webhookSecret: string;
  /** Test hook: point the SDK at a local fake server. Never set in production. */
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
}

type Headers = Record<string, string | string[] | undefined>;

/**
 * Stripe adapter using hosted Checkout + manual capture.
 * Card data is entered on Stripe's hosted page (PCI scope stays with Stripe).
 * Authorization and capture are separated so risk review can hold funds before capture.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly mode = 'live' as const;
  private readonly stripe: Stripe;

  constructor(private readonly options: StripeProviderOptions) {
    this.stripe = new Stripe(options.secretKey, {
      maxNetworkRetries: 2,
      timeout: 10_000,
      ...(options.host ? { host: options.host } : {}),
      ...(options.port ? { port: options.port } : {}),
      ...(options.protocol ? { protocol: options.protocol } : {}),
    });
  }

  async createPayment(input: CreateProviderPaymentInput): Promise<CreateProviderPaymentResult> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: Number(input.amountMinor),
              product_data: { name: input.description.slice(0, 250) },
            },
          },
        ],
        customer_email: input.customerEmail ?? undefined,
        client_reference_id: input.paymentId,
        metadata: input.metadata,
        payment_intent_data: {
          capture_method: 'manual',
          metadata: { payment_id: input.paymentId },
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      },
      // Same payment id => same Checkout Session, so a retried request never creates a second session.
      { idempotencyKey: `checkout_session_${input.paymentId}` },
    );
    if (!session.url) throw new AppError(502, 'provider_error', 'Stripe did not return a checkout URL.');
    return { providerSessionId: session.id, checkoutUrl: session.url };
  }

  async getPaymentStatus(ref: {
    providerPaymentId: string | null;
    providerSessionId: string | null;
    paymentId: string;
  }): Promise<ProviderPaymentStatus> {
    if (!ref.providerPaymentId) {
      return { state: 'pending', providerPaymentId: null, amountMinor: null, currency: null, paymentMethod: null, cardCountry: null };
    }
    const pi = await this.stripe.paymentIntents.retrieve(ref.providerPaymentId, { expand: ['latest_charge'] });
    const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null;
    const card = charge?.payment_method_details?.card ?? null;
    const state =
      pi.status === 'requires_capture'
        ? 'authorized'
        : pi.status === 'succeeded'
          ? 'captured'
          : pi.status === 'canceled'
            ? 'cancelled'
            : 'pending';
    return {
      state,
      providerPaymentId: pi.id,
      amountMinor: BigInt(pi.amount),
      currency: this.toFiat(pi.currency),
      paymentMethod: charge?.payment_method_details?.type ?? null,
      cardCountry: card?.country ?? null,
    };
  }

  async capturePayment(input: { providerPaymentId: string; amountMinor: bigint; idempotencyKey: string }): Promise<{ state: 'captured' }> {
    const pi = await this.stripe.paymentIntents.capture(
      input.providerPaymentId,
      { amount_to_capture: Number(input.amountMinor) },
      { idempotencyKey: input.idempotencyKey },
    );
    if (pi.status !== 'succeeded') throw new AppError(502, 'capture_failed', `Unexpected Stripe status ${pi.status}.`);
    return { state: 'captured' };
  }

  async cancelPayment(input: { providerPaymentId: string; idempotencyKey: string }): Promise<void> {
    await this.stripe.paymentIntents.cancel(input.providerPaymentId, {}, { idempotencyKey: input.idempotencyKey });
  }

  async refundPayment(input: {
    providerPaymentId: string;
    amountMinor: bigint;
    refundId: string;
    reason: 'requested_by_customer' | 'duplicate' | 'fraudulent' | 'other';
  }): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.providerPaymentId,
        amount: Number(input.amountMinor),
        metadata: { refund_id: input.refundId },
        reason: input.reason === 'other' ? undefined : input.reason,
      },
      { idempotencyKey: `refund_${input.refundId}` },
    );
    return {
      providerRefundId: refund.id,
      state: refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' || refund.status === 'canceled' ? 'failed' : 'pending',
    };
  }

  handleWebhook(rawBody: Buffer, headers: Headers): NormalizedProviderEvent[] {
    const signature = headers['stripe-signature'];
    if (typeof signature !== 'string') throw new AppError(400, 'missing_signature', 'Missing Stripe-Signature header.');
    // Throws if the signature or timestamp tolerance check fails.
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.options.webhookSecret);
    return [this.map(event)];
  }

  private map(event: Stripe.Event): NormalizedProviderEvent {
    const base = { eventId: event.id };
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') return { kind: 'ignored', eventId: event.id, type: event.type };
        return this.paymentEvent('payment.authorized', event.id, session.metadata?.payment_id ?? session.client_reference_id, {
          providerSessionId: session.id,
          providerPaymentId: this.idOf(session.payment_intent),
          amountMinor: session.amount_total === null ? null : BigInt(session.amount_total),
          currency: this.toFiat(session.currency),
        });
      }
      case 'payment_intent.amount_capturable_updated': {
        const pi = event.data.object as Stripe.PaymentIntent;
        if (pi.status !== 'requires_capture') return { kind: 'ignored', eventId: event.id, type: event.type };
        return this.paymentEvent('payment.authorized', event.id, pi.metadata?.payment_id ?? null, {
          providerPaymentId: pi.id,
          amountMinor: BigInt(pi.amount),
          currency: this.toFiat(pi.currency),
        });
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        return this.paymentEvent('payment.captured', event.id, pi.metadata?.payment_id ?? null, {
          providerPaymentId: pi.id,
          amountMinor: BigInt(pi.amount_received || pi.amount),
          currency: this.toFiat(pi.currency),
        });
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        return this.paymentEvent('payment.failed', event.id, pi.metadata?.payment_id ?? null, {
          providerPaymentId: pi.id,
          reason: pi.last_payment_error?.code ?? 'payment_failed',
        });
      }
      case 'payment_intent.canceled': {
        const pi = event.data.object as Stripe.PaymentIntent;
        return this.paymentEvent('payment.cancelled', event.id, pi.metadata?.payment_id ?? null, {
          providerPaymentId: pi.id,
          reason: pi.cancellation_reason ?? 'cancelled',
        });
      }
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        return this.paymentEvent('payment.cancelled', event.id, session.metadata?.payment_id ?? session.client_reference_id, {
          providerSessionId: session.id,
          reason: 'checkout_expired',
        });
      }
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return this.paymentEvent('payment.failed', event.id, session.metadata?.payment_id ?? session.client_reference_id, {
          providerSessionId: session.id,
          reason: 'async_payment_failed',
        });
      }
      case 'refund.updated':
      case 'refund.failed': {
        const refund = event.data.object as Stripe.Refund;
        const refundId = refund.metadata?.refund_id;
        if (!refundId) return { kind: 'ignored', eventId: event.id, type: event.type };
        if (refund.status === 'succeeded') {
          return this.refundEvent('refund.succeeded', event.id, refundId, refund);
        }
        if (refund.status === 'failed' || refund.status === 'canceled') {
          return this.refundEvent('refund.failed', event.id, refundId, refund);
        }
        return { kind: 'ignored', eventId: event.id, type: event.type };
      }
      default:
        return { kind: 'ignored', eventId: event.id, type: event.type };
    }
    void base;
  }

  private paymentEvent(
    kind: 'payment.authorized' | 'payment.captured' | 'payment.failed' | 'payment.cancelled',
    eventId: string,
    paymentId: string | null,
    extra: Partial<{
      providerSessionId: string | null;
      providerPaymentId: string | null;
      amountMinor: bigint | null;
      currency: FiatCurrency | null;
      reason: string | null;
    }>,
  ): NormalizedProviderEvent {
    if (!paymentId) return { kind: 'ignored', eventId, type: kind };
    return {
      kind,
      eventId,
      paymentId,
      providerSessionId: extra.providerSessionId ?? null,
      providerPaymentId: extra.providerPaymentId ?? null,
      amountMinor: extra.amountMinor ?? null,
      currency: extra.currency ?? null,
      paymentMethod: null,
      cardCountry: null,
      reason: extra.reason ?? null,
    };
  }

  private refundEvent(kind: 'refund.succeeded' | 'refund.failed', eventId: string, refundId: string, refund: Stripe.Refund): NormalizedProviderEvent {
    const currency = this.toFiat(refund.currency);
    if (!currency) return { kind: 'ignored', eventId, type: kind };
    return {
      kind,
      eventId,
      refundId,
      providerRefundId: refund.id,
      providerPaymentId: this.idOf(refund.payment_intent),
      amountMinor: BigInt(refund.amount),
      currency,
      reason: refund.failure_reason ?? null,
    };
  }

  private idOf(value: string | { id: string } | null | undefined): string | null {
    if (!value) return null;
    return typeof value === 'string' ? value : value.id;
  }

  private toFiat(code: string | null | undefined): FiatCurrency | null {
    if (!code) return null;
    const upper = code.toUpperCase();
    return isFiatCurrency(upper) ? upper : null;
  }
}
