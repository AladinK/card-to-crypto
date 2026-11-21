import { formatFiat } from '../core/money.js';
import type { Mode } from '../core/types.js';
import type { Db } from '../db/pool.js';

export interface SummaryRange {
  from: Date;
  to: Date;
}

/**
 * Merchant dashboard KPIs. All money is returned as decimal strings per currency; crypto totals are
 * excluded from sums of different assets.
 */
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  async summary(merchantId: string, mode: Mode, range: SummaryRange): Promise<Record<string, unknown>> {
    const params = [merchantId, mode, range.from, range.to];

    const payments = await this.db.query(
      `SELECT currency,
              COUNT(*)::int AS payments_total,
              COUNT(*) FILTER (WHERE captured_at IS NOT NULL)::int AS captured_count,
              COALESCE(SUM(amount_minor) FILTER (WHERE captured_at IS NOT NULL), 0)::text AS captured_minor,
              COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_count,
              COUNT(*) FILTER (WHERE status IN ('CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED'))::int AS open_count
       FROM payments WHERE merchant_id = $1 AND mode = $2 AND created_at BETWEEN $3 AND $4 GROUP BY currency ORDER BY currency`,
      params,
    );

    const orders = await this.db.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'))::int AS paid_orders
       FROM orders WHERE merchant_id = $1 AND mode = $2 AND paid_at BETWEEN $3 AND $4`,
      params,
    );

    const settlements = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE s.status NOT IN ('SETTLED', 'FAILED'))::int AS pending_count,
         COUNT(*) FILTER (WHERE s.status = 'SETTLED')::int AS completed_count,
         COUNT(*) FILTER (WHERE s.status = 'FAILED')::int AS failed_count,
         COUNT(*) FILTER (WHERE s.hold)::int AS on_hold_count,
         COALESCE(SUM(s.network_fee_fiat_minor), 0)::text AS network_fee_minor,
         COALESCE(SUM((s.fees->>'paymentFeeMinor')::bigint), 0)::text AS payment_fee_minor,
         COALESCE(SUM((s.fees->>'conversionFeeMinor')::bigint), 0)::text AS conversion_fee_minor,
         COALESCE(SUM((s.fees->>'platformFeeMinor')::bigint), 0)::text AS platform_fee_minor,
         AVG(EXTRACT(EPOCH FROM (s.confirmed_at - p.captured_at))) FILTER (WHERE s.status = 'SETTLED')::float AS avg_settlement_seconds
       FROM settlements s JOIN payments p ON p.id = s.payment_id
       WHERE s.merchant_id = $1 AND s.mode = $2 AND p.created_at BETWEEN $3 AND $4`,
      params,
    );

    const refunds = await this.db.query(
      `SELECT currency, COUNT(*)::int AS count, COALESCE(SUM(amount_minor), 0)::text AS amount_minor,
              COALESCE(SUM(crypto_recovery_fiat_minor) FILTER (WHERE crypto_recovery_status = 'OPEN'), 0)::text AS open_recovery_minor
       FROM refunds WHERE merchant_id = $1 AND mode = $2 AND status = 'SUCCEEDED' AND created_at BETWEEN $3 AND $4 GROUP BY currency`,
      params,
    );

    const rates = await this.db.query(
      `SELECT DISTINCT ON (asset, fiat_currency) asset, fiat_currency, rate::text AS rate, rate_source, created_at
       FROM quotes WHERE merchant_id = $1 AND mode = $2 ORDER BY asset, fiat_currency, created_at DESC`,
      [merchantId, mode],
    );

    const paymentRows = payments.rows;
    const settlementRow = settlements.rows[0] ?? {};
    return {
      period: { from: range.from.toISOString(), to: range.to.toISOString() },
      mode,
      revenue: paymentRows.map((r) => ({
        currency: r.currency,
        amount: formatFiat(BigInt(String(r.captured_minor))),
        captured_count: r.captured_count,
      })),
      payments: {
        total: paymentRows.reduce((sum, r) => sum + Number(r.payments_total), 0),
        failed: paymentRows.reduce((sum, r) => sum + Number(r.failed_count), 0),
        cancelled: paymentRows.reduce((sum, r) => sum + Number(r.cancelled_count), 0),
        open: paymentRows.reduce((sum, r) => sum + Number(r.open_count), 0),
      },
      orders: { paid: orders.rows[0]?.paid_orders ?? 0 },
      settlements: {
        pending: settlementRow.pending_count ?? 0,
        completed: settlementRow.completed_count ?? 0,
        failed: settlementRow.failed_count ?? 0,
        on_hold: settlementRow.on_hold_count ?? 0,
        average_seconds_from_capture: settlementRow.avg_settlement_seconds ?? null,
      },
      refunds: refunds.rows.map((r) => ({
        currency: r.currency,
        count: r.count,
        amount: formatFiat(BigInt(String(r.amount_minor))),
        open_crypto_recovery: formatFiat(BigInt(String(r.open_recovery_minor))),
      })),
      fees: {
        payment: formatFiat(BigInt(String(settlementRow.payment_fee_minor ?? '0'))),
        conversion: formatFiat(BigInt(String(settlementRow.conversion_fee_minor ?? '0'))),
        platform: formatFiat(BigInt(String(settlementRow.platform_fee_minor ?? '0'))),
        blockchain_network: formatFiat(BigInt(String(settlementRow.network_fee_minor ?? '0'))),
        currency_note: 'Fee amounts are in the payment currency; sums are shown only for fee lines recorded on settlements.',
      },
      exchange_rates: rates.rows.map((r) => ({
        asset: r.asset,
        fiat_currency: r.fiat_currency,
        rate: r.rate,
        source: r.rate_source,
        as_of: new Date(String(r.created_at)).toISOString(),
      })),
    };
  }
}
