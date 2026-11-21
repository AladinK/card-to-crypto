import type { Hex } from 'viem';
import { appendAudit } from '../audit/audit.js';
import { ASSETS, type AssetCode, type ChainKey } from '../core/assets.js';
import { rateDeviationBps } from '../core/conversion.js';
import { err, ResourceBusyError } from '../core/errors.js';
import { baseUnitsToDecimal, formatFiat, type FiatCurrency } from '../core/money.js';
import { newId } from '../core/security.js';
import type { PaymentStatus } from '../core/states.js';
import type { Mode } from '../core/types.js';
import type { BlockchainAdapter } from '../blockchain/types.js';
import type { ComplianceEngine } from '../compliance/index.js';
import type { AppConfig } from '../config.js';
import { withTransaction, type Db, type Tx } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { loadMerchant } from '../merchant/service.js';
import { emitEvent } from '../webhooks/outbound.js';
import { isWalletUsable } from '../wallet/service.js';
import { QuoteService } from '../crypto-engine/quotes.js';
import { lockPayment, setOrderStatusForPayment, transitionPayment, type PaymentRecord } from '../payment-engine/repo.js';

export interface SettlementDeps {
  db: Db;
  config: AppConfig;
  chainFor: (mode: Mode, chain: ChainKey) => BlockchainAdapter | null;
  complianceFor: (mode: Mode) => ComplianceEngine;
  quotes: QuoteService;
}

interface SettlementRow {
  id: string;
  payment_id: string;
  merchant_id: string;
  mode: Mode;
  wallet_id: string;
  blockchain: ChainKey;
  asset: AssetCode;
  to_address: string;
  from_address: string | null;
  status: string;
  quote_id: string | null;
  rate: string | null;
  gross_amount_base: string | null;
  amount_base: string | null;
  fees: Record<string, string> | null;
  network_fee_fiat_minor: string | null;
  nonce: string | null;
  signed_tx: string | null;
  tx_hash: string | null;
  required_confirmations: number | null;
  confirmations: number;
  hold: boolean;
  hold_reason: string | null;
}

type StepResult = { requeueMs?: number };

/**
 * Settlement pipeline: quote -> conversion -> on-chain transfer -> confirmations.
 *
 * Each step runs in its own short database transaction and is safe to repeat: it re-reads the
 * payment and settlement under a row lock and acts only if the state still matches. The signed
 * transaction is persisted BEFORE it is broadcast, so a crash can never produce a second transfer
 * with a different nonce.
 */
export class SettlementService {
  constructor(private readonly deps: SettlementDeps) {}

  async advance(paymentId: string): Promise<StepResult> {
    const { rows } = await this.deps.db.query<{ status: PaymentStatus }>('SELECT status FROM payments WHERE id = $1', [paymentId]);
    switch (rows[0]?.status) {
      case 'CONVERSION_PENDING':
        return this.convert(paymentId);
      case 'CONVERSION_COMPLETED':
      case 'CRYPTO_TRANSFER_PENDING':
        return this.transfer(paymentId);
      case 'CRYPTO_TRANSFER_SUBMITTED':
        return this.checkSubmitted(paymentId);
      case 'CRYPTO_CONFIRMING':
        return this.checkConfirmations(paymentId);
      default:
        return {};
    }
  }

  // -------------------------------------------------------------------------
  // Step 1: quote and conversion
  // -------------------------------------------------------------------------

  private async convert(paymentId: string): Promise<StepResult> {
    return withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, paymentId);
      if (!locked) return {};
      const { payment: p, settlement: s } = locked;
      if (p.status !== 'CONVERSION_PENDING' || s.hold) return {};

      const adapter = this.deps.chainFor(p.mode, p.settlementChain);
      if (!adapter) return { requeueMs: 60_000 };
      const merchant = await loadMerchant(tx, p.merchantId);
      const wallet = (await tx.query<{ address: string; status: string; verified_at: Date | null }>(
        'SELECT address, status, verified_at FROM wallets WHERE id = $1',
        [p.settlementWalletId],
      )).rows[0];
      if (!wallet || !isWalletUsable({ status: wallet.status as 'VERIFIED', verified_at: wallet.verified_at }, p.mode, this.deps.config.walletActivationDelayHours)) {
        return this.hold(tx, p, 'WALLET_NOT_ACTIVE');
      }

      const decision = await this.deps.complianceFor(p.mode).checkSettlement({
        merchantId: p.merchantId,
        address: wallet.address,
        blockchain: p.settlementChain,
        asset: p.settlementAsset,
        amountMinor: p.amountMinor,
        currency: p.currency,
        paymentId: p.id,
      });
      if (!decision.allowed) return this.hold(tx, p, decision.holdReason);

      const fresh = await this.deps.quotes.findFresh(tx, p.id);
      if (!fresh) {
        // No valid quote (none yet, or the previous one expired): create a new one.
        const previous = await this.deps.quotes.findLatest(tx, p.id);
        const created = await this.deps.quotes.create(tx, {
          merchantId: p.merchantId,
          mode: p.mode,
          paymentId: p.id,
          fiatMinor: p.amountMinor,
          currency: p.currency,
          asset: p.settlementAsset,
          chain: p.settlementChain,
          destination: wallet.address,
          feeSchedule: merchant.fee_schedule,
        });
        if (previous) {
          const deviation = rateDeviationBps(previous.rate, created.rate);
          if (deviation > merchant.max_rate_deviation_bps) {
            return this.hold(tx, p, `RATE_DEVIATION:${deviation}bps`);
          }
        }
        return { requeueMs: 0 };
      }

      // Execute the conversion with the still-valid quote.
      const networkFeeMinor = String((fresh.fees as Record<string, string>).networkFeeMinor ?? '0');
      await tx.query("UPDATE quotes SET status = 'USED' WHERE id = $1", [fresh.id]);
      await tx.query(
        'INSERT INTO conversions (id, payment_id, settlement_id, quote_id, rate, crypto_amount_base) VALUES ($1, $2, $3, $4, $5, $6)',
        [newId('cnv'), p.id, s.id, fresh.id, fresh.rate.toFixed(18), fresh.merchantNetBase.toString()],
      );
      await tx.query(
        `UPDATE settlements SET status = 'CONVERTED', quote_id = $2, rate = $3, gross_amount_base = $4, amount_base = $5,
           fees = $6, network_fee_fiat_minor = $7, from_address = $8, to_address = $9, updated_at = now()
         WHERE id = $1`,
        [
          s.id,
          fresh.id,
          fresh.rate.toFixed(18),
          fresh.grossCryptoBase.toString(),
          fresh.merchantNetBase.toString(),
          JSON.stringify(fresh.fees),
          networkFeeMinor,
          adapter.treasury.address,
          wallet.address,
        ],
      );
      await transitionPayment(tx, p, 'CONVERSION_COMPLETED', `quote:${fresh.id}`, 'system');
      await transitionPayment(tx, p, 'CRYPTO_TRANSFER_PENDING', 'converted', 'system');

      const decimals = ASSETS[p.settlementAsset].decimals;
      await emitEvent(tx, {
        merchantId: p.merchantId,
        mode: p.mode,
        type: 'conversion.completed',
        paymentId: p.id,
        summary: {
          order_id: await this.orderExternalId(tx, p.id),
          fiat_amount: formatFiat(p.amountMinor),
          fiat_currency: p.currency,
          crypto_asset: p.settlementAsset,
          crypto_amount: baseUnitsToDecimal(fresh.grossCryptoBase, decimals).toFixed(),
          network: p.settlementChain,
          wallet: wallet.address,
          exchange_rate: fresh.rate.toFixed(8),
          status: 'CONVERSION_COMPLETED',
        },
        object: { quote_id: fresh.id, merchant_net_crypto: baseUnitsToDecimal(fresh.merchantNetBase, decimals).toFixed() },
      });
      return { requeueMs: 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Step 2: on-chain transfer (two phases: sign+persist, then broadcast)
  // -------------------------------------------------------------------------

  private async transfer(paymentId: string): Promise<StepResult> {
    const signing = await withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, paymentId);
      if (!locked) return { kind: 'noop' as const };
      const { payment: p, settlement: s } = locked;
      if (p.status !== 'CRYPTO_TRANSFER_PENDING' || s.hold) return { kind: 'noop' as const };

      const adapter = this.deps.chainFor(p.mode, p.settlementChain);
      if (!adapter) return { kind: 'wait' as const, requeueMs: 60_000 };
      if (s.signed_tx && s.tx_hash && s.nonce !== null) {
        return { kind: 'broadcast' as const, adapter, raw: s.signed_tx as Hex, txHash: s.tx_hash as Hex, nonce: BigInt(s.nonce), payment: p, settlementId: s.id };
      }

      const amount = BigInt(s.amount_base ?? '0');
      const treasury = adapter.treasury.address;
      const token = await adapter.getTokenBalance({ address: treasury, asset: p.settlementAsset });
      if (token < amount) {
        await tx.query('UPDATE settlements SET last_error = $2, updated_at = now() WHERE id = $1', [s.id, 'INSUFFICIENT_LIQUIDITY']);
        return { kind: 'wait' as const, requeueMs: 5 * 60_000 };
      }
      const fee = await adapter.estimateFee({ from: treasury, to: s.to_address, asset: p.settlementAsset, amountBaseUnits: amount });
      const native = await adapter.getNativeBalance(treasury);
      if (native < (fee.costBaseUnits * 12n) / 10n) {
        await tx.query('UPDATE settlements SET last_error = $2, updated_at = now() WHERE id = $1', [s.id, 'INSUFFICIENT_GAS']);
        return { kind: 'wait' as const, requeueMs: 2 * 60_000 };
      }

      // Serialize nonce allocation per treasury address across all workers.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`treasury:${treasury.toLowerCase()}`]);
      const chainNonce = await adapter.getNonce(treasury);
      const { rows } = await tx.query<{ max_nonce: string | null }>(
        'SELECT MAX(nonce)::text AS max_nonce FROM settlements WHERE from_address = $1',
        [treasury],
      );
      const dbNonce = rows[0]?.max_nonce ? BigInt(rows[0].max_nonce) + 1n : 0n;
      const nonce = chainNonce > dbNonce ? chainNonce : dbNonce;

      const prepared = adapter.prepareTransfer({ from: treasury, to: s.to_address, asset: p.settlementAsset, amountBaseUnits: amount, nonce, fee });
      const signature = await adapter.treasury.sign(prepared.digest);
      const signed = adapter.finalizeTransfer(prepared, signature);
      await tx.query(
        `UPDATE settlements SET signed_tx = $2, tx_hash = $3, nonce = $4, from_address = $5, attempts = attempts + 1,
           last_error = NULL, updated_at = now() WHERE id = $1`,
        [s.id, signed.raw, signed.txHash, nonce.toString(), treasury],
      );
      return { kind: 'broadcast' as const, adapter, raw: signed.raw, txHash: signed.txHash, nonce, payment: p, settlementId: s.id };
    });

    if (signing.kind === 'noop') return {};
    if (signing.kind === 'wait') return { requeueMs: signing.requeueMs };

    // Phase 2: broadcast the persisted transaction. Re-broadcasting is idempotent.
    const { adapter, raw, txHash, nonce, payment } = signing;
    try {
      await adapter.broadcastTransaction(raw);
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      if (message.includes('nonce')) {
        const status = await adapter.getTransactionStatus(txHash);
        const chainNonce = await adapter.getNonce(adapter.treasury.address);
        if (status === 'not_found' && chainNonce > nonce) {
          await this.resetSigning(payment.id);
          return { requeueMs: 0 };
        }
      }
      throw error;
    }

    await withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, payment.id);
      if (!locked || locked.payment.status !== 'CRYPTO_TRANSFER_PENDING') return;
      await tx.query("UPDATE settlements SET status = 'SUBMITTED', submitted_at = now(), updated_at = now() WHERE id = $1", [locked.settlement.id]);
      await transitionPayment(tx, locked.payment, 'CRYPTO_TRANSFER_SUBMITTED', `tx:${txHash}`, 'system');
    });
    return { requeueMs: adapter.pollIntervalMs };
  }

  private async resetSigning(paymentId: string): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, paymentId);
      if (!locked || locked.payment.status !== 'CRYPTO_TRANSFER_PENDING') return;
      await tx.query('UPDATE settlements SET signed_tx = NULL, tx_hash = NULL, nonce = NULL, updated_at = now() WHERE id = $1', [locked.settlement.id]);
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: submitted -> verified on-chain
  // -------------------------------------------------------------------------

  private async checkSubmitted(paymentId: string): Promise<StepResult> {
    return withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, paymentId);
      if (!locked) return {};
      const { payment: p, settlement: s } = locked;
      if (p.status !== 'CRYPTO_TRANSFER_SUBMITTED' || !s.tx_hash || !s.signed_tx) return {};
      const adapter = this.deps.chainFor(p.mode, p.settlementChain);
      if (!adapter) return { requeueMs: 60_000 };
      const txHash = s.tx_hash as Hex;

      const status = await adapter.getTransactionStatus(txHash);
      if (status === 'pending') return { requeueMs: adapter.pollIntervalMs };

      if (status === 'not_found') {
        // Dropped from the mempool: rebroadcast the same signed transaction.
        await adapter.broadcastTransaction(s.signed_tx as Hex);
        const after = await adapter.getTransactionStatus(txHash);
        if (after !== 'not_found') return { requeueMs: adapter.pollIntervalMs };
        const chainNonce = await adapter.getNonce(s.from_address ?? adapter.treasury.address);
        if (s.nonce !== null && chainNonce > BigInt(s.nonce)) {
          // Our nonce was used by someone else: this transaction can never be mined. Sign again.
          await tx.query('UPDATE settlements SET signed_tx = NULL, tx_hash = NULL, nonce = NULL, updated_at = now() WHERE id = $1', [s.id]);
          await transitionPayment(tx, p, 'CRYPTO_TRANSFER_PENDING', 'resubmit_after_dropped_tx', 'system');
          await tx.query("UPDATE settlements SET status = 'CONVERTED', updated_at = now() WHERE id = $1", [s.id]);
          return { requeueMs: 0 };
        }
        return { requeueMs: adapter.pollIntervalMs };
      }

      if (status === 'reverted') return this.fail(tx, p, s, 'TX_REVERTED');

      const delivered = await adapter.verifyTransferEvent({
        txHash,
        asset: p.settlementAsset,
        to: s.to_address,
        amountBaseUnits: BigInt(s.amount_base ?? '0'),
      });
      if (!delivered) return this.fail(tx, p, s, 'TRANSFER_MISMATCH');

      await tx.query(
        "UPDATE settlements SET status = 'CONFIRMING', required_confirmations = $2, updated_at = now() WHERE id = $1",
        [s.id, adapter.requiredConfirmations],
      );
      await transitionPayment(tx, p, 'CRYPTO_CONFIRMING', `mined:${txHash}`, 'system');
      return { requeueMs: 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Step 4: confirmations -> SETTLED
  // -------------------------------------------------------------------------

  private async checkConfirmations(paymentId: string): Promise<StepResult> {
    return withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, paymentId);
      if (!locked) return {};
      const { payment: p, settlement: s } = locked;
      if (p.status !== 'CRYPTO_CONFIRMING' || !s.tx_hash) return {};
      const adapter = this.deps.chainFor(p.mode, p.settlementChain);
      if (!adapter) return { requeueMs: 60_000 };

      const required = s.required_confirmations ?? adapter.requiredConfirmations;
      const count = await adapter.getConfirmationCount(s.tx_hash as Hex);
      await tx.query('UPDATE settlements SET confirmations = $2, updated_at = now() WHERE id = $1', [s.id, count]);
      if (count < required) return { requeueMs: adapter.pollIntervalMs };

      await transitionPayment(tx, p, 'SETTLED', `confirmations:${count}`, 'system');
      await tx.query("UPDATE settlements SET status = 'SETTLED', confirmed_at = now(), updated_at = now() WHERE id = $1", [s.id]);

      const merchant = await loadMerchant(tx, p.merchantId);
      if (merchant.order_paid_trigger === 'SETTLEMENT_CONFIRMED') await setOrderStatusForPayment(tx, p.id, 'PAID');

      const decimals = ASSETS[p.settlementAsset].decimals;
      await emitEvent(tx, {
        merchantId: p.merchantId,
        mode: p.mode,
        type: 'settlement.confirmed',
        paymentId: p.id,
        summary: {
          order_id: await this.orderExternalId(tx, p.id),
          fiat_amount: formatFiat(p.amountMinor),
          fiat_currency: p.currency,
          crypto_asset: p.settlementAsset,
          crypto_amount: s.amount_base ? baseUnitsToDecimal(BigInt(s.amount_base), decimals).toFixed() : null,
          network: p.settlementChain,
          wallet: s.to_address,
          tx_hash: s.tx_hash,
          status: 'confirmed',
        },
        object: { confirmations: count, settlement_id: s.id },
      });
      return {};
    });
  }

  // -------------------------------------------------------------------------
  // Operator actions
  // -------------------------------------------------------------------------

  /** Releases a settlement hold (compliance review, rate deviation, amount review...) and resumes it. */
  async release(paymentId: string, actor: string): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, paymentId);
      if (!locked) throw err.notFound('Settlement');
      await tx.query('UPDATE settlements SET hold = FALSE, hold_reason = NULL, updated_at = now() WHERE id = $1', [locked.settlement.id]);
      await enqueue(tx, 'settlement.advance', { paymentId }, { dedupeKey: `settle:${paymentId}` });
      await appendAudit(tx, {
        actorType: 'admin',
        actorId: actor,
        merchantId: locked.payment.merchantId,
        action: 'settlement.released',
        entityType: 'settlement',
        entityId: locked.settlement.id,
        data: { previous_hold: locked.settlement.hold_reason },
      });
    });
  }

  /** Retries a settlement that failed after capture. Re-quotes and signs again with a fresh nonce. */
  async retry(paymentId: string, actor: string): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const locked = await this.lock(tx, paymentId);
      if (!locked) throw err.notFound('Settlement');
      const { payment: p, settlement: s } = locked;
      if (p.status !== 'FAILED' || !p.capturedAt) {
        throw err.conflict('retry_not_allowed', 'Only settlements that failed after capture can be retried.', { status: p.status });
      }
      await transitionPayment(tx, p, 'CONVERSION_PENDING', 'operator_retry', actor);
      await tx.query(
        `UPDATE settlements SET status = 'PENDING', quote_id = NULL, rate = NULL, gross_amount_base = NULL, amount_base = NULL,
           fees = NULL, network_fee_fiat_minor = NULL, signed_tx = NULL, tx_hash = NULL, nonce = NULL, confirmations = 0,
           hold = FALSE, hold_reason = NULL, last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [s.id],
      );
      await enqueue(tx, 'settlement.advance', { paymentId }, { dedupeKey: `settle:${paymentId}` });
      await appendAudit(tx, { actorType: 'admin', actorId: actor, merchantId: p.merchantId, action: 'settlement.retry', entityType: 'settlement', entityId: s.id });
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async lock(tx: Tx, paymentId: string): Promise<{ payment: PaymentRecord; settlement: SettlementRow } | null> {
    const payment = await lockPayment(tx, paymentId, true);
    if (!payment) return null;
    try {
      const { rows } = await tx.query<SettlementRow>('SELECT * FROM settlements WHERE payment_id = $1 FOR UPDATE NOWAIT', [paymentId]);
      return rows[0] ? { payment, settlement: rows[0] } : null;
    } catch (error) {
      if ((error as { code?: string }).code === '55P03') throw new ResourceBusyError(`settlement ${paymentId}`);
      throw error;
    }
  }

  private async hold(tx: Tx, p: PaymentRecord, reason: string): Promise<StepResult> {
    await tx.query('UPDATE settlements SET hold = TRUE, hold_reason = $2, updated_at = now() WHERE payment_id = $1', [p.id, reason]);
    await appendAudit(tx, {
      actorType: 'system',
      merchantId: p.merchantId,
      action: 'settlement.held',
      entityType: 'payment',
      entityId: p.id,
      data: { reason },
    });
    return {};
  }

  private async fail(tx: Tx, p: PaymentRecord, s: SettlementRow, reason: string): Promise<StepResult> {
    await transitionPayment(tx, p, 'FAILED', reason, 'system');
    await tx.query("UPDATE settlements SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1", [s.id, reason]);
    await emitEvent(tx, {
      merchantId: p.merchantId,
      mode: p.mode,
      type: 'settlement.failed',
      paymentId: p.id,
      summary: { order_id: await this.orderExternalId(tx, p.id), fiat_amount: formatFiat(p.amountMinor), fiat_currency: p.currency, status: 'FAILED', reason },
      object: { settlement_id: s.id },
    });
    await appendAudit(tx, {
      actorType: 'system',
      merchantId: p.merchantId,
      action: 'settlement.failed',
      entityType: 'settlement',
      entityId: s.id,
      data: { reason, tx_hash: s.tx_hash },
    });
    return {};
  }

  private async orderExternalId(tx: Tx, paymentId: string): Promise<string> {
    const { rows } = await tx.query('SELECT o.external_order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1', [paymentId]);
    return String(rows[0]?.external_order_id ?? '');
  }
}

export type { FiatCurrency };
