import { ResourceBusyError } from '../core/errors.js';
import { assertTransition, type PaymentStatus } from '../core/states.js';
import { err } from '../core/errors.js';
import type { ChainKey, AssetCode } from '../core/assets.js';
import type { FiatCurrency } from '../core/money.js';
import type { Mode } from '../core/types.js';
import type { Tx } from '../db/pool.js';

export interface PaymentRecord {
  id: string;
  merchantId: string;
  mode: Mode;
  orderId: string;
  storeId: string | null;
  status: PaymentStatus;
  provider: string;
  providerSessionId: string | null;
  providerPaymentId: string | null;
  checkoutUrl: string | null;
  amountMinor: bigint;
  currency: FiatCurrency;
  refundedMinor: bigint;
  paymentMethod: string | null;
  cardCountry: string | null;
  customerEmail: string | null;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  settlementChain: ChainKey;
  settlementAsset: AssetCode;
  settlementWalletId: string;
  riskLevel: string | null;
  riskScore: number | null;
  metadata: Record<string, string>;
  failureReason: string | null;
  holdReason: string | null;
  expiresAt: Date;
  capturedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mapPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: String(row.id),
    merchantId: String(row.merchant_id),
    mode: row.mode as Mode,
    orderId: String(row.order_id),
    storeId: (row.store_id as string | null) ?? null,
    status: row.status as PaymentStatus,
    provider: String(row.provider),
    providerSessionId: (row.provider_session_id as string | null) ?? null,
    providerPaymentId: (row.provider_payment_id as string | null) ?? null,
    checkoutUrl: (row.checkout_url as string | null) ?? null,
    amountMinor: BigInt(String(row.amount_minor)),
    currency: row.currency as FiatCurrency,
    refundedMinor: BigInt(String(row.refunded_minor)),
    paymentMethod: (row.payment_method as string | null) ?? null,
    cardCountry: (row.card_country as string | null) ?? null,
    customerEmail: (row.customer_email as string | null) ?? null,
    description: String(row.description ?? ''),
    returnUrl: String(row.return_url),
    cancelUrl: String(row.cancel_url),
    settlementChain: row.settlement_blockchain as ChainKey,
    settlementAsset: row.settlement_asset as AssetCode,
    settlementWalletId: String(row.settlement_wallet_id),
    riskLevel: (row.risk_level as string | null) ?? null,
    riskScore: row.risk_score === null || row.risk_score === undefined ? null : Number(row.risk_score),
    metadata: (row.metadata as Record<string, string>) ?? {},
    failureReason: (row.failure_reason as string | null) ?? null,
    holdReason: (row.hold_reason as string | null) ?? null,
    expiresAt: new Date(String(row.expires_at)),
    capturedAt: row.captured_at ? new Date(String(row.captured_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

/** Locks the payment row. `nowait` turns contention into a retryable ResourceBusyError. */
export async function lockPayment(tx: Tx, id: string, nowait = false): Promise<PaymentRecord | null> {
  try {
    const { rows } = await tx.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE${nowait ? ' NOWAIT' : ''}`, [id]);
    return rows[0] ? mapPayment(rows[0]) : null;
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') throw new ResourceBusyError(`payment ${id}`);
    throw error;
  }
}

/**
 * Moves a payment to a new status. Validates the transition, guards against concurrent writers
 * with a compare-and-set, and appends to the immutable transition log.
 */
export async function transitionPayment(
  tx: Tx,
  payment: PaymentRecord,
  to: PaymentStatus,
  reason: string,
  actor: string,
): Promise<void> {
  const from = payment.status;
  assertTransition(from, to);
  const result = await tx.query(
    'UPDATE payments SET status = $3, version = version + 1, updated_at = now() WHERE id = $1 AND status = $2',
    [payment.id, from, to],
  );
  if (result.rowCount !== 1) throw err.conflict('concurrent_update', 'Payment changed concurrently. Retry.');
  payment.status = to;
  await tx.query(
    'INSERT INTO payment_transitions (payment_id, from_status, to_status, reason, actor) VALUES ($1, $2, $3, $4, $5)',
    [payment.id, from, to, reason, actor],
  );
}

export async function setOrderStatusForPayment(tx: Tx, paymentId: string, status: string): Promise<void> {
  await tx.query(
    `UPDATE orders SET status = $2, updated_at = now(), paid_at = CASE WHEN $2 = 'PAID' THEN COALESCE(paid_at, now()) ELSE paid_at END
     WHERE id = (SELECT order_id FROM payments WHERE id = $1)`,
    [paymentId, status],
  );
}

export async function hasOpenPaymentForOrder(tx: Tx, orderId: string, excludePaymentId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM payments WHERE order_id = $1 AND id <> $2 AND status IN ('CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED') LIMIT 1`,
    [orderId, excludePaymentId],
  );
  return rows.length > 0;
}
