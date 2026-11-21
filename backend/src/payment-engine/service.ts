import { appendAudit } from '../audit/audit.js';
import type { AppConfig } from '../config.js';
import { ASSETS, type AssetCode, type ChainKey } from '../core/assets.js';
import { AppError, err, ResourceBusyError } from '../core/errors.js';
import { baseUnitsToDecimal, formatFiat, parseFiatAmount, type FiatCurrency } from '../core/money.js';
import { newId, sha256Hex } from '../core/security.js';
import { canTransition, OPEN_PAYMENT_STATUSES, type PaymentStatus } from '../core/states.js';
import type { Mode } from '../core/types.js';
import type { FraudProvider } from '../compliance/index.js';
import type { Db, Tx } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { assertWritable, type AuthContext } from '../merchant/auth.js';
export { assertWritable };
import { loadMerchant, type MerchantRecord } from '../merchant/service.js';
import type { NormalizedProviderEvent, PaymentProvider, PaymentProviderEvent } from '../payment-processors/types.js';
import { assessRisk, isDisposableEmail, type RiskSignals } from '../risk/engine.js';
import { emitEvent } from '../webhooks/outbound.js';
import type { WalletService } from '../wallet/service.js';
import { hasOpenPaymentForOrder, lockPayment, mapPayment, setOrderStatusForPayment, transitionPayment, type PaymentRecord } from './repo.js';

export interface PaymentEngineDeps {
  db: Db;
  config: AppConfig;
  providerFor: (mode: Mode) => PaymentProvider;
  fraudFor: (mode: Mode) => FraudProvider;
  wallets: WalletService;
  chainActive: (mode: Mode, chain: ChainKey) => Promise<boolean>;
}

export interface CreatePaymentInput {
  amount: string;
  currency: FiatCurrency;
  orderId: string;
  customerEmail: string | null;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  storeId: string | null;
  settlement: { walletId?: string | undefined; blockchain?: string | undefined; asset?: string | undefined };
  idempotencyKey: string;
}

export const REFUND_REASONS = ['requested_by_customer', 'duplicate', 'fraudulent', 'other'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** Deterministic id from (merchant, mode, idempotency key): a retried request lands on the same row. */
export function derivedId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256Hex(parts.join('|')).slice(0, 24)}`;
}

export function assertCanTransact(merchant: MerchantRecord, mode: Mode): void {
  if (merchant.status !== 'ACTIVE') throw err.forbidden('merchant_frozen', 'This account is suspended.');
  if (mode === 'live' && (!merchant.live_enabled || merchant.kyb_status !== 'APPROVED')) {
    throw err.forbidden('live_mode_not_enabled', 'Live payments are not enabled for this account.');
  }
}

export function paymentView(p: PaymentRecord, walletAddress: string | null): Record<string, unknown> {
  return {
    id: p.id,
    object: 'payment',
    mode: p.mode,
    status: p.status,
    order_id: p.orderId,
    amount: formatFiat(p.amountMinor),
    amount_minor: p.amountMinor.toString(),
    currency: p.currency,
    refunded_amount: formatFiat(p.refundedMinor),
    description: p.description,
    payment_method: p.paymentMethod,
    customer: { email: p.customerEmail },
    checkout_url: p.checkoutUrl,
    settlement: {
      blockchain: p.settlementChain,
      asset: p.settlementAsset,
      wallet_id: p.settlementWalletId,
      wallet_address: walletAddress,
    },
    risk_level: p.riskLevel,
    hold_reason: p.holdReason,
    failure_reason: p.failureReason,
    metadata: p.metadata,
    created_at: p.createdAt.toISOString(),
    expires_at: p.expiresAt.toISOString(),
    captured_at: p.capturedAt?.toISOString() ?? null,
  };
}

/**
 * Payment engine: owns the payment state machine, provider event ingestion, refunds and the
 * capture / void jobs. Settlement (conversion + on-chain transfer) lives in settlement/service.ts.
 */
export class PaymentService {
  constructor(private readonly deps: PaymentEngineDeps) {}

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async createPayment(ctx: AuthContext, merchant: MerchantRecord, input: CreatePaymentInput): Promise<Record<string, unknown>> {
    const mode = ctx.mode;
    assertWritable(ctx);
    assertCanTransact(merchant, mode);
    const amountMinor = parseFiatAmount(input.amount);

    const wallet = await this.deps.wallets.resolveForPayment(this.deps.db, merchant.id, mode, {
      walletId: input.settlement.walletId,
      blockchain: input.settlement.blockchain,
      asset: input.settlement.asset,
    });
    if (!(await this.deps.chainActive(mode, wallet.blockchain))) {
      throw err.unavailable('chain_unavailable', `${wallet.blockchain} settlement is not available right now.`);
    }

    const paymentId = derivedId('pay', merchant.id, mode, input.idempotencyKey);

    // Phase 1 (DB): reserve the order, run risk checks, create the payment in CREATED.
    const phase1 = await withTransaction(this.deps.db, async (tx) => {
      const upserted = await tx.query(
        `INSERT INTO orders (id, merchant_id, mode, external_order_id, status, amount_minor, currency)
         VALUES ($1, $2, $3, $4, 'UNPAID', $5, $6)
         ON CONFLICT (merchant_id, mode, external_order_id) DO UPDATE SET updated_at = now()
         RETURNING *`,
        [newId('ord'), merchant.id, mode, input.orderId, amountMinor.toString(), input.currency],
      );
      const order = upserted.rows[0];
      if (!order) throw err.unavailable('order_error', 'Could not reserve order.');
      if (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED' || order.status === 'REFUNDED') {
        throw err.conflict('order_already_paid', 'This order has already been paid.', { order_id: input.orderId });
      }

      const existing = await lockPayment(tx, paymentId);
      // Same key retried after a crash: a finished payment is returned as-is; a CREATED one resumes at the provider step.
      if (existing && existing.status !== 'CREATED') return { kind: 'existing' as const, payment: existing };
      if (existing) return { kind: 'proceed' as const, payment: existing };

      const open = await tx.query(
        `SELECT id, amount_minor, currency FROM payments WHERE order_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
        [order.id, OPEN_PAYMENT_STATUSES],
      );
      const openRow = open.rows[0];
      if (openRow) {
        const sameTerms = BigInt(String(openRow.amount_minor)) === amountMinor && openRow.currency === input.currency;
        throw err.conflict(
          sameTerms ? 'payment_already_open' : 'order_amount_mismatch',
          sameTerms ? 'An open payment already exists for this order.' : 'The order already has an open payment with different terms.',
          { payment_id: String(openRow.id) },
        );
      }

      const signals = await this.gatherSignals(tx, merchant, mode, input.customerEmail, amountMinor);
      const external = await this.deps.fraudFor(mode).scoreCheckout({ merchantId: merchant.id, email: input.customerEmail, ipAddress: ctx.ip });
      const assessment = assessRisk({ ...signals, externalScore: external.score, externalReasons: external.reasons }, merchant.risk_thresholds);
      await tx.query(
        `INSERT INTO risk_events (merchant_id, payment_id, stage, score, level, reasons) VALUES ($1, $2, 'pre_checkout', $3, $4, $5)`,
        [merchant.id, paymentId, assessment.score, assessment.level, JSON.stringify(assessment.reasons)],
      );
      if (assessment.level === 'BLOCKED') return { kind: 'blocked' as const };

      const expiresAt = new Date(Date.now() + this.deps.config.checkoutTtlMinutes * 60_000);
      await tx.query(
        `INSERT INTO payments (id, merchant_id, mode, order_id, store_id, status, provider, amount_minor, currency,
           customer_email, description, return_url, cancel_url, settlement_blockchain, settlement_asset,
           settlement_wallet_id, risk_level, risk_score, metadata, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'CREATED', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          paymentId,
          merchant.id,
          mode,
          order.id,
          input.storeId,
          this.deps.providerFor(mode).name,
          amountMinor.toString(),
          input.currency,
          input.customerEmail,
          input.description,
          input.returnUrl,
          input.cancelUrl,
          wallet.blockchain,
          wallet.asset,
          wallet.id,
          assessment.level,
          assessment.score,
          JSON.stringify(input.metadata),
          expiresAt,
        ],
      );
      await tx.query("UPDATE orders SET status = 'PENDING_PAYMENT', updated_at = now() WHERE id = $1", [order.id]);
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId: merchant.id,
        action: 'payment.created',
        entityType: 'payment',
        entityId: paymentId,
        data: { order_id: input.orderId, amount_minor: amountMinor.toString(), risk_level: assessment.level },
        ip: ctx.ip,
      });
      const created = await lockPayment(tx, paymentId);
      return { kind: 'created' as const, payment: created as PaymentRecord };
    });

    if (phase1.kind === 'blocked') {
      throw err.forbidden('payment_declined', 'The payment could not be accepted.');
    }
    if (phase1.kind === 'existing') {
      return this.view(phase1.payment);
    }

    // Phase 2 (provider, outside any DB transaction): create the hosted checkout.
    const provider = this.deps.providerFor(mode);
    const bridge = (outcome: string) => `${this.deps.config.publicBaseUrl}/checkout/return/${paymentId}?outcome=${outcome}`;
    let session;
    try {
      session = await provider.createPayment({
        paymentId,
        mode,
        amountMinor,
        currency: input.currency,
        description: input.description || `Order ${input.orderId}`,
        customerEmail: input.customerEmail,
        successUrl: bridge('success'),
        cancelUrl: bridge('cancelled'),
        expiresAt: phase1.payment.expiresAt,
        metadata: { payment_id: paymentId, order_id: input.orderId },
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw err.unavailable('provider_unavailable', 'Payment provider is unavailable. Retry with the same Idempotency-Key.');
    }

    // Phase 3 (DB): store the checkout and move to PAYMENT_PENDING.
    const payment = await withTransaction(this.deps.db, async (tx) => {
      const current = await lockPayment(tx, paymentId);
      if (!current) throw err.notFound('Payment');
      await tx.query(
        `UPDATE payments SET provider_session_id = $2, checkout_url = $3, updated_at = now()
         WHERE id = $1 AND provider_session_id IS NULL`,
        [paymentId, session.providerSessionId, session.checkoutUrl],
      );
      if (current.status === 'CREATED') {
        await transitionPayment(tx, current, 'PAYMENT_PENDING', 'provider_session_created', 'system');
        await emitEvent(tx, {
          merchantId: merchant.id,
          mode,
          type: 'payment.created',
          paymentId,
          summary: { order_id: input.orderId, fiat_amount: formatFiat(amountMinor), fiat_currency: input.currency, status: 'PAYMENT_PENDING' },
          object: {},
        });
      }
      return (await lockPayment(tx, paymentId)) as PaymentRecord;
    });
    return this.view(payment);
  }

  private async gatherSignals(
    tx: Tx,
    merchant: MerchantRecord,
    mode: Mode,
    email: string | null,
    amountMinor: bigint,
  ): Promise<RiskSignals> {
    const normalized = email?.toLowerCase() ?? null;
    let lastHour = 0;
    let failed24h = 0;
    if (normalized) {
      const counts = await tx.query<{ last_hour: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_hour,
                count(*) FILTER (WHERE status IN ('FAILED', 'CANCELLED') AND created_at > now() - interval '24 hours')::int AS failed
         FROM payments WHERE merchant_id = $1 AND mode = $2 AND lower(customer_email) = $3`,
        [merchant.id, mode, normalized],
      );
      lastHour = counts.rows[0]?.last_hour ?? 0;
      failed24h = counts.rows[0]?.failed ?? 0;
    }
    return {
      amountMinor,
      highValueMinor: merchant.high_value_threshold_minor,
      paymentsLastHourSameEmail: lastHour,
      paymentsLastHourSameIp: 0,
      failedLast24hSameEmail: failed24h,
      disposableEmail: isDisposableEmail(normalized),
      ipReputation: 'unknown',
      processorRisk: null,
      billingCountry: null,
      cardCountry: null,
      externalScore: 0,
      externalReasons: [],
    };
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async getPayment(merchantId: string, mode: Mode, id: string): Promise<Record<string, unknown>> {
    const payment = await this.load(merchantId, mode, id);
    return this.view(payment);
  }

  async listPayments(
    merchantId: string,
    mode: Mode,
    options: { status?: string | undefined; limit: number; startingAfter?: string | undefined },
  ): Promise<{ data: Record<string, unknown>[]; has_more: boolean }> {
    const params: unknown[] = [merchantId, mode, options.limit + 1];
    let where = 'p.merchant_id = $1 AND p.mode = $2';
    if (options.status) {
      params.push(options.status);
      where += ` AND p.status = $${params.length}`;
    }
    if (options.startingAfter) {
      params.push(options.startingAfter);
      where += ` AND p.created_at < (SELECT created_at FROM payments WHERE id = $${params.length} AND merchant_id = $1)`;
    }
    const { rows } = await this.deps.db.query(
      `SELECT p.*, w.address AS wallet_address FROM payments p JOIN wallets w ON w.id = p.settlement_wallet_id
       WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      params,
    );
    const hasMore = rows.length > options.limit;
    const data = rows.slice(0, options.limit).map((row) => paymentView(mapPayment(row), row.wallet_address as string));
    return { data, has_more: hasMore };
  }

  async listTransactions(merchantId: string, mode: Mode, limit: number): Promise<Record<string, unknown>[]> {
    const { rows } = await this.deps.db.query(
      `SELECT p.id, p.order_id, o.external_order_id, p.amount_minor, p.currency, p.payment_method, p.status AS payment_status,
              p.created_at, p.refunded_minor, p.settlement_blockchain, p.settlement_asset, w.address AS wallet_address,
              s.status AS settlement_status, s.rate, s.gross_amount_base, s.amount_base, s.fees, s.tx_hash,
              s.confirmed_at, s.network_fee_fiat_minor, s.asset
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN wallets w ON w.id = p.settlement_wallet_id
       LEFT JOIN settlements s ON s.payment_id = p.id
       WHERE p.merchant_id = $1 AND p.mode = $2
       ORDER BY p.created_at DESC LIMIT $3`,
      [merchantId, mode, limit],
    );
    return rows.map((row) => {
      const fees = (row.fees as Record<string, string> | null) ?? null;
      const asset = (row.asset ?? row.settlement_asset) as AssetCode;
      const decimals = ASSETS[asset].decimals;
      const merchantReceived = row.amount_base ? baseUnitsToDecimal(BigInt(String(row.amount_base)), decimals).toFixed() : null;
      const grossCrypto = row.gross_amount_base ? baseUnitsToDecimal(BigInt(String(row.gross_amount_base)), decimals).toFixed() : null;
      return {
        payment_id: row.id,
        order_id: row.external_order_id,
        customer_amount: formatFiat(BigInt(String(row.amount_minor))),
        currency: row.currency,
        payment_method: row.payment_method,
        payment_status: row.payment_status,
        refunded_amount: formatFiat(BigInt(String(row.refunded_minor))),
        crypto_asset: asset,
        crypto_amount: grossCrypto,
        exchange_rate: row.rate ? String(row.rate) : null,
        payment_fee: fees ? formatFiat(BigInt(fees.paymentFeeMinor ?? "0")) : null,
        conversion_fee: fees ? formatFiat(BigInt(fees.conversionFeeMinor ?? "0")) : null,
        platform_fee: fees ? formatFiat(BigInt(fees.platformFeeMinor ?? "0")) : null,
        network_fee: row.network_fee_fiat_minor === null ? null : formatFiat(BigInt(String(row.network_fee_fiat_minor))),
        merchant_received: merchantReceived,
        wallet_address: row.wallet_address,
        blockchain: row.settlement_blockchain,
        transaction_hash: row.tx_hash,
        settlement_status: row.settlement_status,
        timestamp: new Date(String(row.created_at)).toISOString(),
        settled_at: row.confirmed_at ? new Date(String(row.confirmed_at)).toISOString() : null,
      };
    });
  }

  async getSettlement(merchantId: string, mode: Mode, paymentId: string): Promise<Record<string, unknown>> {
    await this.load(merchantId, mode, paymentId);
    const { rows } = await this.deps.db.query(
      `SELECT s.*, q.rate_source, q.expires_at AS quote_expires_at, q.status AS quote_status
       FROM settlements s LEFT JOIN quotes q ON q.id = s.quote_id WHERE s.payment_id = $1`,
      [paymentId],
    );
    const s = rows[0];
    if (!s) return { payment_id: paymentId, status: 'NOT_CREATED' };
    const decimals = ASSETS[s.asset as AssetCode].decimals;
    return {
      id: s.id,
      payment_id: paymentId,
      status: s.status,
      hold: s.hold,
      hold_reason: s.hold_reason,
      blockchain: s.blockchain,
      asset: s.asset,
      wallet_address: s.to_address,
      exchange_rate: s.rate ? String(s.rate) : null,
      rate_source: s.rate_source ?? null,
      crypto_amount: s.gross_amount_base ? baseUnitsToDecimal(BigInt(String(s.gross_amount_base)), decimals).toFixed() : null,
      merchant_received: s.amount_base ? baseUnitsToDecimal(BigInt(String(s.amount_base)), decimals).toFixed() : null,
      fees: s.fees,
      network_fee: s.network_fee_fiat_minor === null ? null : formatFiat(BigInt(String(s.network_fee_fiat_minor))),
      transaction_hash: s.tx_hash,
      confirmations: s.confirmations,
      required_confirmations: s.required_confirmations,
      last_error: s.last_error,
      submitted_at: s.submitted_at ? new Date(s.submitted_at).toISOString() : null,
      confirmed_at: s.confirmed_at ? new Date(s.confirmed_at).toISOString() : null,
    };
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  async createRefund(
    ctx: AuthContext,
    merchant: MerchantRecord,
    paymentId: string,
    input: { amount: string | undefined; reason: RefundReason; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    assertWritable(ctx);
    const mode = ctx.mode;
    if (merchant.status !== 'ACTIVE') throw err.forbidden('merchant_frozen', 'This account is suspended.');
    const payment = await this.load(merchant.id, mode, paymentId);
    const refundId = derivedId('ref', merchant.id, mode, input.idempotencyKey);

    // Retried request: the refund already exists, so only the provider step is repeated (idempotent).
    const existing = await this.deps.db.query('SELECT * FROM refunds WHERE id = $1', [refundId]);
    if (!existing.rows[0]) {
      if (payment.status !== 'SETTLED' && payment.status !== 'PARTIALLY_REFUNDED') {
        throw err.conflict('refund_not_allowed', 'Refunds are available once the crypto settlement is confirmed.', { status: payment.status });
      }
      const pendingRows = await this.deps.db.query<{ pending: string }>(
        "SELECT COALESCE(SUM(amount_minor), 0)::text AS pending FROM refunds WHERE payment_id = $1 AND status = 'PENDING'",
        [paymentId],
      );
      const pending = BigInt(pendingRows.rows[0]?.pending ?? '0');
      const refundable = payment.amountMinor - payment.refundedMinor - pending;
      const amountMinor = input.amount ? parseFiatAmount(input.amount) : refundable;
      if (refundable <= 0n || amountMinor > refundable) {
        throw err.unprocessable('refund_exceeds_refundable', 'Refund amount exceeds the refundable balance.', {
          refundable: formatFiat(refundable > 0n ? refundable : 0n),
        });
      }

      await withTransaction(this.deps.db, async (tx) => {
        const settlement = await tx.query('SELECT id, amount_base, asset FROM settlements WHERE payment_id = $1', [paymentId]);
        const s = settlement.rows[0];
        await tx.query(
          `INSERT INTO refunds (id, payment_id, merchant_id, mode, amount_minor, currency, status, reason,
             original_settlement_id, original_crypto_amount_base, original_asset)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10)`,
          [
            refundId,
            paymentId,
            merchant.id,
            mode,
            amountMinor.toString(),
            payment.currency,
            input.reason,
            s?.id ?? null,
            s?.amount_base ?? null,
            s?.asset ?? null,
          ],
        );
        await emitEvent(tx, {
          merchantId: merchant.id,
          mode,
          type: 'refund.created',
          paymentId,
          summary: { order_id: payment.orderId, refund_id: refundId, fiat_amount: formatFiat(amountMinor), fiat_currency: payment.currency },
          object: { id: refundId, amount: formatFiat(amountMinor) },
        });
        await appendAudit(tx, {
          actorType: ctx.kind === 'user' ? 'user' : 'api_key',
          actorId: ctx.userId ?? ctx.apiKeyId,
          merchantId: merchant.id,
          action: 'refund.created',
          entityType: 'refund',
          entityId: refundId,
          data: { payment_id: paymentId, amount_minor: amountMinor.toString() },
          ip: ctx.ip,
        });
      });
    }

    const refundRow = (await this.deps.db.query('SELECT * FROM refunds WHERE id = $1', [refundId])).rows[0];
    if (refundRow.status !== 'PENDING') return this.refundView(refundRow);

    const provider = this.deps.providerFor(mode);
    if (!payment.providerPaymentId) throw err.unprocessable('payment_not_captured', 'The payment has no provider reference.');
    let result;
    try {
      result = await provider.refundPayment({
        providerPaymentId: payment.providerPaymentId,
        amountMinor: BigInt(String(refundRow.amount_minor)),
        refundId,
        reason: (input.reason as RefundReason) === 'other' ? 'other' : input.reason,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw err.unavailable('provider_unavailable', 'Refund provider is unavailable. Retry with the same Idempotency-Key.');
    }

    await withTransaction(this.deps.db, async (tx) => {
      const locked = await tx.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
      const current = locked.rows[0];
      if (!current) return;
      await tx.query('UPDATE refunds SET provider_refund_id = $2, updated_at = now() WHERE id = $1 AND provider_refund_id IS NULL', [
        refundId,
        result.providerRefundId,
      ]);
      if (current.status !== 'PENDING') return;
      if (result.state === 'succeeded') await this.applyRefundSucceeded(tx, refundId);
      else if (result.state === 'failed') await this.markRefundFailed(tx, refundId);
    });

    return this.refundView((await this.deps.db.query('SELECT * FROM refunds WHERE id = $1', [refundId])).rows[0]);
  }

  private async applyRefundSucceeded(tx: Tx, refundId: string): Promise<void> {
    const { rows } = await tx.query(
      `UPDATE refunds SET status = 'SUCCEEDED',
         crypto_recovery_status = CASE WHEN original_settlement_id IS NOT NULL THEN 'OPEN' ELSE 'NONE' END,
         crypto_recovery_fiat_minor = CASE WHEN original_settlement_id IS NOT NULL THEN amount_minor ELSE 0 END,
         updated_at = now()
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [refundId],
    );
    const refund = rows[0];
    if (!refund) return;
    const payment = await lockPayment(tx, String(refund.payment_id));
    if (!payment) return;
    const refunded = payment.refundedMinor + BigInt(String(refund.amount_minor));
    await tx.query('UPDATE payments SET refunded_minor = $2, updated_at = now() WHERE id = $1', [payment.id, refunded.toString()]);
    payment.refundedMinor = refunded;
    const target: PaymentStatus = refunded >= payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (payment.status !== target) {
      if (!canTransition(payment.status, target)) {
        throw err.conflict('invalid_state_transition', `Cannot record refund while payment is ${payment.status}.`);
      }
      await transitionPayment(tx, payment, target, 'refund_succeeded', 'provider');
    }
    await setOrderStatusForPayment(tx, payment.id, target === 'REFUNDED' ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
    await emitEvent(tx, {
      merchantId: String(refund.merchant_id),
      mode: payment.mode,
      type: 'refund.completed',
      paymentId: payment.id,
      summary: { order_id: payment.orderId, refund_id: refundId, fiat_amount: formatFiat(BigInt(String(refund.amount_minor))), fiat_currency: payment.currency, status: target },
      object: { id: refundId, status: 'SUCCEEDED' },
    });
  }

  private async markRefundFailed(tx: Tx, refundId: string): Promise<void> {
    const { rows } = await tx.query("UPDATE refunds SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'PENDING' RETURNING *", [refundId]);
    const refund = rows[0];
    if (!refund) return;
    const payment = await tx.query('SELECT merchant_id, mode, order_id FROM payments WHERE id = $1', [refund.payment_id]);
    const p = payment.rows[0];
    await emitEvent(tx, {
      merchantId: String(refund.merchant_id),
      mode: p.mode,
      type: 'refund.failed',
      paymentId: String(refund.payment_id),
      summary: { refund_id: refundId },
      object: { id: refundId, status: 'FAILED' },
    });
  }

  private refundView(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      object: 'refund',
      payment_id: row.payment_id,
      status: row.status,
      amount: formatFiat(BigInt(String(row.amount_minor))),
      currency: row.currency,
      reason: row.reason,
      provider_refund_id: row.provider_refund_id ?? null,
      crypto_recovery: {
        status: row.crypto_recovery_status,
        amount: formatFiat(BigInt(String(row.crypto_recovery_fiat_minor ?? 0))),
        note: 'Crypto is never reversed automatically. An open recovery is owed by the merchant (see docs/REFUND_POLICY.md).',
      },
      created_at: new Date(String(row.created_at)).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Provider events (webhooks and internal simulations)
  // -------------------------------------------------------------------------

  /** Applies provider events. Each event is recorded once; replays are reported as duplicates. */
  async ingest(providerName: string, events: NormalizedProviderEvent[]): Promise<{ applied: number; duplicates: number; ignored: number }> {
    const summary = { applied: 0, duplicates: 0, ignored: 0 };
    for (const event of events) {
      const outcome = await withTransaction(this.deps.db, (tx) => this.ingestOne(tx, providerName, event));
      if (outcome === 'applied') summary.applied++;
      else if (outcome === 'duplicate') summary.duplicates++;
      else summary.ignored++;
    }
    return summary;
  }

  private async ingestOne(tx: Tx, providerName: string, event: NormalizedProviderEvent): Promise<'applied' | 'duplicate' | 'ignored'> {
    const inserted = await tx.query(
      `INSERT INTO provider_events (provider, event_id, type, payload, status)
       VALUES ($1, $2, $3, $4, 'RECEIVED') ON CONFLICT DO NOTHING RETURNING event_id`,
      [providerName, event.eventId, event.kind, JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))],
    );
    if (inserted.rowCount === 0) return 'duplicate';
    const outcome = event.kind === 'ignored' ? 'ignored' : await this.apply(tx, providerName, event);
    await tx.query('UPDATE provider_events SET status = $3, processed_at = now() WHERE provider = $1 AND event_id = $2', [
      providerName,
      event.eventId,
      outcome === 'applied' ? 'PROCESSED' : 'IGNORED',
    ]);
    return outcome;
  }

  private async apply(tx: Tx, providerName: string, event: NormalizedProviderEvent): Promise<'applied' | 'ignored'> {
    if (event.kind === 'ignored') return 'ignored';
    if (event.kind === 'refund.succeeded' || event.kind === 'refund.failed') {
      const { rows } = await tx.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [event.refundId]);
      const refund = rows[0];
      if (!refund || refund.status !== 'PENDING') return 'ignored';
      if (event.kind === 'refund.succeeded') {
        await this.applyRefundSucceeded(tx, refund.id);
      } else {
        await this.markRefundFailed(tx, refund.id);
      }
      return 'applied';
    }

    const payEvent = event as PaymentProviderEvent;
    const payment = await lockPayment(tx, payEvent.paymentId);
    if (!payment) return 'ignored';

    // Defence in depth: an event must reference the checkout we created for this payment.
    const sessionMismatch =
      payEvent.providerSessionId !== null && payment.providerSessionId !== null && payEvent.providerSessionId !== payment.providerSessionId;
    const sandboxMismatch = providerName === 'sandbox' && payEvent.providerPaymentId !== null && payEvent.providerPaymentId !== `sandbox_pi_${payment.id}`;
    if (sessionMismatch || sandboxMismatch) {
      await appendAudit(tx, {
        actorType: 'provider',
        actorId: providerName,
        merchantId: payment.merchantId,
        action: 'provider.reference_mismatch',
        entityType: 'payment',
        entityId: payment.id,
        data: { event_id: event.eventId, session: sessionMismatch, payment_reference: sandboxMismatch },
      });
      return 'ignored';
    }
    if (event.providerPaymentId && payment.providerPaymentId && payment.providerPaymentId !== event.providerPaymentId) {
      await appendAudit(tx, {
        actorType: 'provider',
        actorId: providerName,
        merchantId: payment.merchantId,
        action: 'provider.reference_mismatch',
        entityType: 'payment',
        entityId: payment.id,
        data: { event_id: event.eventId },
      });
      return 'ignored';
    }
    if ((event.kind === 'payment.authorized' || event.kind === 'payment.captured') && event.amountMinor !== null) {
      if (event.amountMinor !== payment.amountMinor || event.currency !== payment.currency) {
        await tx.query("UPDATE payments SET hold_reason = 'AMOUNT_MISMATCH', updated_at = now() WHERE id = $1", [payment.id]);
        await appendAudit(tx, {
          actorType: 'provider',
          actorId: providerName,
          merchantId: payment.merchantId,
          action: 'payment.amount_mismatch',
          entityType: 'payment',
          entityId: payment.id,
          data: { event_id: event.eventId, amount_minor: event.amountMinor.toString() },
        });
        return 'ignored';
      }
    }
    if (event.providerPaymentId && !payment.providerPaymentId) {
      await tx.query('UPDATE payments SET provider_payment_id = $2 WHERE id = $1', [payment.id, event.providerPaymentId]);
      payment.providerPaymentId = event.providerPaymentId;
    }
    if (event.kind === 'payment.authorized' || event.kind === 'payment.captured') {
      await tx.query(
        'UPDATE payments SET payment_method = COALESCE($2, payment_method), card_country = COALESCE($3, card_country) WHERE id = $1',
        [payment.id, event.paymentMethod, event.cardCountry],
      );
    }

    switch (event.kind) {
      case 'payment.authorized':
        return this.onAuthorized(tx, payment, providerName, event.eventId);
      case 'payment.captured':
        return this.onCaptured(tx, payment, providerName, event.eventId);
      case 'payment.failed':
        return this.onTerminalFailure(tx, payment, 'FAILED', event.reason ?? 'payment_failed', providerName);
      case 'payment.cancelled':
        return this.onTerminalFailure(tx, payment, 'CANCELLED', event.reason ?? 'cancelled', providerName);
    }
  }

  private async onAuthorized(tx: Tx, payment: PaymentRecord, providerName: string, eventId: string): Promise<'applied' | 'ignored'> {
    if (payment.status === 'CREATED') {
      await transitionPayment(tx, payment, 'PAYMENT_PENDING', 'provider_session_created', 'provider');
    }
    if (payment.status !== 'PAYMENT_PENDING') return 'ignored';
    await transitionPayment(tx, payment, 'PAYMENT_AUTHORIZED', `authorized:${eventId}`, providerName);
    await emitEvent(tx, {
      merchantId: payment.merchantId,
      mode: payment.mode,
      type: 'payment.authorized',
      paymentId: payment.id,
      summary: { order_id: await this.orderExternalId(tx, payment.id), fiat_amount: formatFiat(payment.amountMinor), fiat_currency: payment.currency, status: 'PAYMENT_AUTHORIZED' },
      object: { id: payment.id },
    });

    if (payment.riskLevel === 'HIGH') {
      // Authorized but not captured: a human reviews the payment before funds are taken.
      await tx.query("UPDATE payments SET hold_reason = 'RISK_REVIEW', updated_at = now() WHERE id = $1", [payment.id]);
      return 'applied';
    }
    await enqueue(tx, 'payment.capture', { paymentId: payment.id }, { dedupeKey: `capture:${payment.id}` });
    return 'applied';
  }

  private async onCaptured(tx: Tx, payment: PaymentRecord, providerName: string, eventId: string): Promise<'applied' | 'ignored'> {
    if (payment.status === 'CREATED') await transitionPayment(tx, payment, 'PAYMENT_PENDING', 'provider_session_created', 'provider');
    if (payment.status === 'PAYMENT_PENDING') await transitionPayment(tx, payment, 'PAYMENT_AUTHORIZED', `authorized:${eventId}`, providerName);
    if (payment.status !== 'PAYMENT_AUTHORIZED') return 'ignored';

    await transitionPayment(tx, payment, 'PAYMENT_CAPTURED', `captured:${eventId}`, providerName);
    await tx.query('UPDATE payments SET captured_at = now(), updated_at = now() WHERE id = $1', [payment.id]);
    payment.capturedAt = new Date();
    await transitionPayment(tx, payment, 'CONVERSION_PENDING', 'settlement_started', 'system');

    const merchant = await loadMerchant(tx, payment.merchantId);
    if (merchant.order_paid_trigger === 'PAYMENT_CAPTURED') {
      await setOrderStatusForPayment(tx, payment.id, 'PAID');
    }

    const holdReason = payment.amountMinor >= merchant.settlement_review_threshold_minor ? 'AMOUNT_REVIEW' : null;
    await tx.query(
      `INSERT INTO settlements (id, payment_id, merchant_id, mode, wallet_id, blockchain, asset, to_address, status, hold, hold_reason)
       SELECT $1, $2, $3, $4, w.id, $5, $6, w.address, 'PENDING', $7, $8 FROM wallets w WHERE w.id = $9
       ON CONFLICT (payment_id) DO NOTHING`,
      [newId('stl'), payment.id, payment.merchantId, payment.mode, payment.settlementChain, payment.settlementAsset, holdReason !== null, holdReason, payment.settlementWalletId],
    );

    const orderId = await this.orderExternalId(tx, payment.id);
    await emitEvent(tx, {
      merchantId: payment.merchantId,
      mode: payment.mode,
      type: 'payment.captured',
      paymentId: payment.id,
      summary: { order_id: orderId, fiat_amount: formatFiat(payment.amountMinor), fiat_currency: payment.currency, status: 'PAYMENT_CAPTURED' },
      object: { id: payment.id, payment_method: payment.paymentMethod },
    });
    await emitEvent(tx, {
      merchantId: payment.merchantId,
      mode: payment.mode,
      type: 'settlement.created',
      paymentId: payment.id,
      summary: { order_id: orderId, fiat_amount: formatFiat(payment.amountMinor), fiat_currency: payment.currency, crypto_asset: payment.settlementAsset, network: payment.settlementChain, wallet: null, status: 'PENDING' },
      object: { payment_id: payment.id, hold: holdReason },
    });
    await enqueue(tx, 'settlement.advance', { paymentId: payment.id }, { dedupeKey: `settle:${payment.id}` });
    return 'applied';
  }

  private async onTerminalFailure(
    tx: Tx,
    payment: PaymentRecord,
    to: 'FAILED' | 'CANCELLED',
    reason: string,
    providerName: string,
  ): Promise<'applied' | 'ignored'> {
    if (!(['CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED'] as PaymentStatus[]).includes(payment.status)) return 'ignored';
    await tx.query('UPDATE payments SET failure_reason = $2, updated_at = now() WHERE id = $1', [payment.id, reason]);
    await transitionPayment(tx, payment, to, reason, providerName);
    const orderId = await this.orderExternalId(tx, payment.id);
    if (!(await hasOpenPaymentForOrder(tx, await this.orderIdOf(tx, payment.id), payment.id))) {
      await setOrderStatusForPayment(tx, payment.id, 'UNPAID');
    }
    await emitEvent(tx, {
      merchantId: payment.merchantId,
      mode: payment.mode,
      type: to === 'FAILED' ? 'payment.failed' : 'payment.cancelled',
      paymentId: payment.id,
      summary: { order_id: orderId, fiat_amount: formatFiat(payment.amountMinor), fiat_currency: payment.currency, status: to, reason },
      object: { id: payment.id },
    });
    return 'applied';
  }

  // -------------------------------------------------------------------------
  // Jobs and sweeps
  // -------------------------------------------------------------------------

  /** Job: captures an authorized payment (unless held for review). Idempotent. */
  async runCapture(paymentId: string): Promise<void> {
    const row = await this.loadById(paymentId);
    if (!row || row.status !== 'PAYMENT_AUTHORIZED' || row.holdReason) return;
    const provider = this.deps.providerFor(row.mode);
    if (!row.providerPaymentId) throw new Error('Authorized payment has no provider payment id.');
    await provider.capturePayment({ providerPaymentId: row.providerPaymentId, amountMinor: row.amountMinor, idempotencyKey: `capture_${row.id}` });
    await this.ingest(provider.name, [
      {
        kind: 'payment.captured',
        eventId: `capture:${row.id}`,
        paymentId: row.id,
        providerSessionId: row.providerSessionId,
        providerPaymentId: row.providerPaymentId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        paymentMethod: row.paymentMethod,
        cardCountry: row.cardCountry,
        reason: null,
      },
    ]);
  }

  /** Job: releases an authorization that will not be captured (e.g. rejected in review). */
  async runCancelAuthorization(paymentId: string): Promise<void> {
    const row = await this.loadById(paymentId);
    if (!row || row.status !== 'PAYMENT_AUTHORIZED' || !row.providerPaymentId) return;
    const provider = this.deps.providerFor(row.mode);
    await provider.cancelPayment({ providerPaymentId: row.providerPaymentId, idempotencyKey: `void_${row.id}` });
    await this.ingest(provider.name, [
      { kind: 'payment.cancelled', eventId: `void:${row.id}`, paymentId: row.id, providerSessionId: null, providerPaymentId: row.providerPaymentId, amountMinor: null, currency: null, paymentMethod: null, cardCountry: null, reason: 'review_rejected' },
    ]);
  }

  /** Sweep: abandoned checkouts (customer closed the page) and stale CREATED rows. */
  async expireStale(limit = 100): Promise<number> {
    const { rows } = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM payments WHERE (status = 'PAYMENT_PENDING' AND expires_at < now())
         OR (status = 'CREATED' AND created_at < now() - interval '30 minutes')
       ORDER BY expires_at LIMIT $1`,
      [limit],
    );
    let expired = 0;
    for (const row of rows) {
      try {
        const changed = await withTransaction(this.deps.db, async (tx) => {
          const p = await lockPayment(tx, row.id, true);
          if (!p) return false;
          const stale = (p.status === 'PAYMENT_PENDING' && p.expiresAt.getTime() < Date.now()) || p.status === 'CREATED';
          if (!stale) return false;
          await this.onTerminalFailure(tx, p, 'CANCELLED', 'checkout_expired', 'system');
          return true;
        });
        if (changed) expired++;
      } catch (error) {
        if (!(error instanceof ResourceBusyError)) throw error;
      }
    }
    return expired;
  }

  /** Operator action: release a payment held for review and capture it. */
  async releaseCaptureHold(paymentId: string, actor: string): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const p = await lockPayment(tx, paymentId);
      if (!p) throw err.notFound('Payment');
      if (p.status !== 'PAYMENT_AUTHORIZED') throw err.conflict('invalid_state', 'Only authorized payments can be captured.', { status: p.status });
      await tx.query('UPDATE payments SET hold_reason = NULL, updated_at = now() WHERE id = $1', [paymentId]);
      await enqueue(tx, 'payment.capture', { paymentId }, { dedupeKey: `capture:${paymentId}` });
      await appendAudit(tx, { actorType: 'admin', actorId: actor, merchantId: p.merchantId, action: 'payment.hold_released', entityType: 'payment', entityId: paymentId });
    });
  }

  /** Operator action: reject a payment held for review and release the authorization. */
  async rejectHeldPayment(paymentId: string, actor: string): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const p = await lockPayment(tx, paymentId);
      if (!p) throw err.notFound('Payment');
      if (p.status !== 'PAYMENT_AUTHORIZED') throw err.conflict('invalid_state', 'Only authorized payments can be rejected.', { status: p.status });
      await enqueue(tx, 'payment.cancel_authorization', { paymentId }, { dedupeKey: `void:${paymentId}` });
      await appendAudit(tx, { actorType: 'admin', actorId: actor, merchantId: p.merchantId, action: 'payment.rejected', entityType: 'payment', entityId: paymentId });
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async load(merchantId: string, mode: Mode, id: string): Promise<PaymentRecord> {
    const { rows } = await this.deps.db.query('SELECT * FROM payments WHERE id = $1 AND merchant_id = $2 AND mode = $3', [id, merchantId, mode]);
    if (!rows[0]) throw err.notFound('Payment');
    return mapPayment(rows[0]);
  }

  private async loadById(id: string): Promise<PaymentRecord | null> {
    const { rows } = await this.deps.db.query('SELECT * FROM payments WHERE id = $1', [id]);
    return rows[0] ? mapPayment(rows[0]) : null;
  }

  private async view(payment: PaymentRecord): Promise<Record<string, unknown>> {
    const { rows } = await this.deps.db.query('SELECT address FROM wallets WHERE id = $1', [payment.settlementWalletId]);
    return paymentView(payment, (rows[0]?.address as string | undefined) ?? null);
  }

  private async orderExternalId(tx: Tx, paymentId: string): Promise<string> {
    const { rows } = await tx.query('SELECT o.external_order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1', [paymentId]);
    return String(rows[0]?.external_order_id ?? '');
  }

  private async orderIdOf(tx: Tx, paymentId: string): Promise<string> {
    const { rows } = await tx.query('SELECT order_id FROM payments WHERE id = $1', [paymentId]);
    return String(rows[0]?.order_id ?? '');
  }
}

