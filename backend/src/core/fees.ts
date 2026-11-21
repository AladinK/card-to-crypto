import { Decimal } from 'decimal.js';
import { err } from './errors.js';
import { decimalToFiatMinor } from './money.js';

/**
 * Fee policy. Rates are basis points (1 bps = 0.01%) of the gross customer amount.
 * The payment fee is an estimate of the acquirer's cost; the actual provider fee is
 * recorded when the provider reports it.
 */
export interface FeeSchedule {
  paymentFeeBps: number;
  paymentFeeFixedMinor: bigint;
  conversionFeeBps: number;
  platformFeeBps: number;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  paymentFeeBps: 150,
  paymentFeeFixedMinor: 25n,
  conversionFeeBps: 50,
  platformFeeBps: 50,
};

export interface FiatFeeBreakdown {
  grossMinor: bigint;
  paymentFeeMinor: bigint;
  conversionFeeMinor: bigint;
  platformFeeMinor: bigint;
  networkFeeMinor: bigint;
  totalFeeMinor: bigint;
  merchantNetMinor: bigint;
}

/** Computes every fee in fiat minor units. Rounding is half-up for percentage fees. */
export function computeFiatFees(input: {
  grossMinor: bigint;
  networkFeeMinor: bigint;
  schedule: FeeSchedule;
}): FiatFeeBreakdown {
  const { grossMinor, networkFeeMinor, schedule } = input;
  if (grossMinor <= 0n) throw err.unprocessable('invalid_amount', 'gross amount must be positive.');
  if (networkFeeMinor < 0n) throw err.unprocessable('invalid_fee', 'network fee cannot be negative.');

  // All values here are already in minor units (cents); percentages are applied to cents directly.
  const gross = new Decimal(grossMinor.toString());
  const percent = (bps: number): Decimal => gross.mul(bps).div(10_000);
  const roundMinor = (value: Decimal): bigint => BigInt(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));

  const paymentFeeMinor = roundMinor(percent(schedule.paymentFeeBps).plus(schedule.paymentFeeFixedMinor.toString()));
  const conversionFeeMinor = roundMinor(percent(schedule.conversionFeeBps));
  const platformFeeMinor = roundMinor(percent(schedule.platformFeeBps));
  const totalFeeMinor = paymentFeeMinor + conversionFeeMinor + platformFeeMinor + networkFeeMinor;
  const merchantNetMinor = grossMinor - totalFeeMinor;

  if (merchantNetMinor <= 0n) {
    throw err.unprocessable('amount_too_small', 'amount does not cover settlement fees.', {
      total_fee_minor: totalFeeMinor.toString(),
    });
  }

  return {
    grossMinor,
    paymentFeeMinor,
    conversionFeeMinor,
    platformFeeMinor,
    networkFeeMinor,
    totalFeeMinor,
    merchantNetMinor,
  };
}

/**
 * Converts an on-chain fee (base units of the gas token) to fiat minor units.
 * Rounded UP so that the platform never under-recovers network costs.
 */
export function networkFeeFiatMinor(input: {
  costBaseUnits: bigint;
  gasTokenDecimals: number;
  gasTokenRateFiat: Decimal;
}): bigint {
  const tokens = new Decimal(input.costBaseUnits.toString()).div(new Decimal(10).pow(input.gasTokenDecimals));
  return decimalToFiatMinor(tokens.mul(input.gasTokenRateFiat), Decimal.ROUND_UP);
}
