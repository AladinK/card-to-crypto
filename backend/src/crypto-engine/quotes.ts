import { Decimal } from 'decimal.js';
import { ASSETS, CHAINS, type AssetCode, type ChainKey } from '../core/assets.js';
import { convertFiatToCrypto, QUOTE_TTL_SECONDS, type ConversionResult } from '../core/conversion.js';
import { computeFiatFees, networkFeeFiatMinor, DEFAULT_FEE_SCHEDULE, type FeeSchedule, type FiatFeeBreakdown } from '../core/fees.js';
import { decimalToBaseUnits, type FiatCurrency } from '../core/money.js';
import { newId } from '../core/security.js';
import type { Mode } from '../core/types.js';
import type { BlockchainAdapter } from '../blockchain/types.js';
import type { Queryable } from '../db/pool.js';
import type { RateProvider } from './rates.js';

export interface QuoteRecord {
  id: string;
  paymentId: string | null;
  merchantId: string;
  mode: Mode;
  fiatMinor: bigint;
  currency: FiatCurrency;
  asset: AssetCode;
  chain: ChainKey;
  rate: Decimal;
  rateSource: string;
  fees: FiatFeeBreakdown;
  conversion: ConversionResult;
  expiresAt: Date;
  status: 'ACTIVE' | 'USED' | 'EXPIRED';
}

export interface QuoteDeps {
  ratesFor: (mode: Mode) => RateProvider;
  adapterFor: (mode: Mode, chain: ChainKey) => BlockchainAdapter | null;
  defaultFees: FeeSchedule;
}

/** Quote engine: rate + network estimate + fee breakdown, valid for QUOTE_TTL_SECONDS (30 s). */
export class QuoteService {
  constructor(private readonly deps: QuoteDeps) {}

  async create(
    db: Queryable,
    input: {
      merchantId: string;
      mode: Mode;
      paymentId: string | null;
      fiatMinor: bigint;
      currency: FiatCurrency;
      asset: AssetCode;
      chain: ChainKey;
      destination: string;
      feeSchedule: FeeSchedule | null;
    },
  ): Promise<QuoteRecord> {
    const adapter = this.deps.adapterFor(input.mode, input.chain);
    if (!adapter) throw new QuoteUnavailable(`Chain ${input.chain} is not active in ${input.mode} mode.`);
    const rates = this.deps.ratesFor(input.mode);
    const chainDef = CHAINS[input.chain];

    const [assetRate, gasRate] = await Promise.all([
      rates.getRate(input.asset, input.currency),
      rates.getRate(chainDef.gasToken, input.currency),
    ]);

    // Estimate the transfer cost with the expected amount (gross, before fees).
    const approxBase = decimalToBaseUnits(
      new Decimal(input.fiatMinor.toString()).div(100).div(assetRate.rate),
      ASSETS[input.asset].decimals,
      Decimal.ROUND_DOWN,
    );
    const fee = await adapter.estimateFee({
      from: adapter.treasury.address,
      to: input.destination,
      asset: input.asset,
      amountBaseUnits: approxBase > 0n ? approxBase : 1n,
    });

    const networkFeeMinor = networkFeeFiatMinor({
      costBaseUnits: fee.costBaseUnits,
      gasTokenDecimals: ASSETS[chainDef.gasToken].decimals,
      gasTokenRateFiat: gasRate.rate,
    });
    const fees = computeFiatFees({
      grossMinor: input.fiatMinor,
      networkFeeMinor,
      schedule: input.feeSchedule ?? this.deps.defaultFees ?? DEFAULT_FEE_SCHEDULE,
    });
    const conversion = convertFiatToCrypto({ fees, rate: assetRate.rate, decimals: ASSETS[input.asset].decimals });

    const id = newId('qte');
    const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);
    await db.query(
      `INSERT INTO quotes (id, merchant_id, payment_id, mode, fiat_amount_minor, fiat_currency, asset, blockchain,
         rate, rate_source, gross_amount_base, merchant_net_base, fees, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ACTIVE', $14)`,
      [
        id,
        input.merchantId,
        input.paymentId,
        input.mode,
        input.fiatMinor.toString(),
        input.currency,
        input.asset,
        input.chain,
        assetRate.rate.toFixed(18),
        assetRate.source,
        conversion.grossCryptoBase.toString(),
        conversion.merchantNetBase.toString(),
        JSON.stringify(serializeFees(fees, networkFeeMinor)),
        expiresAt,
      ],
    );

    return {
      id,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      mode: input.mode,
      fiatMinor: input.fiatMinor,
      currency: input.currency,
      asset: input.asset,
      chain: input.chain,
      rate: assetRate.rate,
      rateSource: assetRate.source,
      fees,
      conversion,
      expiresAt,
      status: 'ACTIVE',
    };
  }

  /** Latest quote for a payment that is still valid, or null. */
  async findFresh(db: Queryable, paymentId: string): Promise<{ id: string; rate: Decimal; merchantNetBase: bigint; grossCryptoBase: bigint; fees: Record<string, unknown> } | null> {
    const { rows } = await db.query(
      `SELECT * FROM quotes WHERE payment_id = $1 AND status = 'ACTIVE' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [paymentId],
    );
    return rows[0] ? mapStoredQuote(rows[0]) : null;
  }

  async findLatest(db: Queryable, paymentId: string): Promise<{ id: string; rate: Decimal; merchantNetBase: bigint; grossCryptoBase: bigint; fees: Record<string, unknown> } | null> {
    const { rows } = await db.query('SELECT * FROM quotes WHERE payment_id = $1 ORDER BY created_at DESC LIMIT 1', [paymentId]);
    return rows[0] ? mapStoredQuote(rows[0]) : null;
  }
}

export class QuoteUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteUnavailable';
  }
}

function mapStoredQuote(row: Record<string, unknown>): { id: string; rate: Decimal; merchantNetBase: bigint; grossCryptoBase: bigint; fees: Record<string, unknown> } {
  return {
    id: String(row.id),
    rate: new Decimal(String(row.rate)),
    merchantNetBase: BigInt(String(row.merchant_net_base)),
    grossCryptoBase: BigInt(String(row.gross_amount_base)),
    fees: row.fees as Record<string, unknown>,
  };
}

function serializeFees(fees: FiatFeeBreakdown, networkFeeMinor: bigint): Record<string, string> {
  return {
    grossMinor: fees.grossMinor.toString(),
    paymentFeeMinor: fees.paymentFeeMinor.toString(),
    conversionFeeMinor: fees.conversionFeeMinor.toString(),
    platformFeeMinor: fees.platformFeeMinor.toString(),
    networkFeeMinor: networkFeeMinor.toString(),
    totalFeeMinor: fees.totalFeeMinor.toString(),
    merchantNetMinor: fees.merchantNetMinor.toString(),
  };
}
