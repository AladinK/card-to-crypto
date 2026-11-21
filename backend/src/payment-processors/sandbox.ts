import { AppError } from '../core/errors.js';
import { isFiatCurrency, type FiatCurrency } from '../core/money.js';
import { hmacHex, safeEqual, sha256Hex } from '../core/security.js';
import type {
  CreateProviderPaymentInput,
  CreateProviderPaymentResult,
  NormalizedProviderEvent,
  PaymentProvider,
  ProviderPaymentStatus,
  RefundResult,
} from './types.js';

export const SANDBOX_CARD_SIGNATURE_HEADER = 'x-sandbox-signature';

/** Test cards understood by the sandbox checkout page (mirrors well-known processor test PANs). */
export const SANDBOX_TEST_CARDS = [
  { number: '4242 4242 4242 4242', outcome: 'success', description: 'Approved' },
  { number: '4000 0000 0000 0002', outcome: 'decline', description: 'Declined by issuer' },
  { number: '4000 0000 0000 9995', outcome: 'decline', description: 'Insufficient funds' },
] as const;

export interface SandboxProviderOptions {
  publicBaseUrl: string;
  /** Used to sign checkout links and simulated webhook payloads. */
  secret: string;
}

/**
 * Sandbox card provider: no money moves, nothing leaves the process.
 * Payment outcomes are chosen on the sandbox checkout page with test cards.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly mode = 'test' as const;

  constructor(private readonly options: SandboxProviderOptions) {}

  async createPayment(input: CreateProviderPaymentInput): Promise<CreateProviderPaymentResult> {
    const token = this.checkoutToken(input.paymentId);
    const url = new URL(`/checkout/sandbox/${input.paymentId}`, this.options.publicBaseUrl);
    url.searchParams.set('t', token);
    return { providerSessionId: `sandbox_session_${input.paymentId}`, checkoutUrl: url.toString() };
  }

  async getPaymentStatus(ref: { paymentId: string }): Promise<ProviderPaymentStatus> {
    // Sandbox has no external state; the payment engine's database is the source of truth.
    return { state: 'pending', providerPaymentId: `sandbox_pi_${ref.paymentId}`, amountMinor: null, currency: null, paymentMethod: 'sandbox_card', cardCountry: 'RS' };
  }

  async capturePayment(input: { providerPaymentId: string }): Promise<{ state: 'captured' }> {
    if (!input.providerPaymentId.startsWith('sandbox_pi_')) throw new AppError(400, 'invalid_reference', 'Not a sandbox payment.');
    return { state: 'captured' };
  }

  async cancelPayment(): Promise<void> {
    return undefined;
  }

  async refundPayment(input: { providerPaymentId: string; refundId: string }): Promise<RefundResult> {
    return { providerRefundId: `sandbox_re_${sha256Hex(input.refundId).slice(0, 24)}`, state: 'succeeded' };
  }

  /** Verifies a simulated provider event signed with the sandbox secret. */
  handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedProviderEvent[] {
    const signature = headers[SANDBOX_CARD_SIGNATURE_HEADER];
    if (typeof signature !== 'string' || !safeEqual(signature, hmacHex(this.options.secret, rawBody))) {
      throw new AppError(401, 'invalid_signature', 'Invalid sandbox event signature.');
    }
    const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    return [toNormalized(parsed)];
  }

  checkoutToken(paymentId: string): string {
    return hmacHex(this.options.secret, `sandbox-checkout:${paymentId}`);
  }

  verifyCheckoutToken(paymentId: string, token: string | undefined): boolean {
    return typeof token === 'string' && safeEqual(token, this.checkoutToken(paymentId));
  }

  /** Signs an event body the same way an external simulator would (used by tests and tooling). */
  signEvent(rawBody: string): string {
    return hmacHex(this.options.secret, rawBody);
  }
}

function toNormalized(input: Record<string, unknown>): NormalizedProviderEvent {
  const kind = String(input.kind ?? 'ignored');
  const eventId = String(input.eventId ?? '');
  if (!eventId) throw new AppError(400, 'invalid_event', 'eventId is required.');
  if (kind === 'refund.succeeded' || kind === 'refund.failed') {
    const currency = toFiat(input.currency);
    if (!currency) throw new AppError(400, 'invalid_event', 'Unsupported currency.');
    return {
      kind,
      eventId,
      refundId: String(input.refundId),
      providerRefundId: String(input.providerRefundId),
      providerPaymentId: input.providerPaymentId ? String(input.providerPaymentId) : null,
      amountMinor: BigInt(String(input.amountMinor)),
      currency,
      reason: input.reason ? String(input.reason) : null,
    };
  }
  if (kind === 'payment.authorized' || kind === 'payment.captured' || kind === 'payment.failed' || kind === 'payment.cancelled') {
    return {
      kind,
      eventId,
      paymentId: String(input.paymentId),
      providerSessionId: input.providerSessionId ? String(input.providerSessionId) : null,
      providerPaymentId: input.providerPaymentId ? String(input.providerPaymentId) : null,
      amountMinor: input.amountMinor === undefined || input.amountMinor === null ? null : BigInt(String(input.amountMinor)),
      currency: toFiat(input.currency),
      paymentMethod: input.paymentMethod ? String(input.paymentMethod) : null,
      cardCountry: input.cardCountry ? String(input.cardCountry) : null,
      reason: input.reason ? String(input.reason) : null,
    };
  }
  return { kind: 'ignored', eventId, type: kind };
}

function toFiat(value: unknown): FiatCurrency | null {
  if (typeof value !== 'string') return null;
  return isFiatCurrency(value) ? value : null;
}
