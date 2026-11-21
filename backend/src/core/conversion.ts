import { Decimal } from 'decimal.js';
import { err } from './errors.js';
import { decimalToBaseUnits } from './money.js';
import type { FiatFeeBreakdown } from './fees.js';

export const QUOTE_TTL_SECONDS = 30;

export interface ConversionResult {
  /** Fiat major units per 1 crypto unit, e.g. 0.92 EUR per USDC. */
  rate: Decimal;
  /** Customer amount expressed in crypto before fees (informational, floor). */
  grossCryptoBase: bigint;
  /** Amount that is actually transferred on-chain to the merchant (after all fees, floor). */
  merchantNetBase: bigint;
  merchantNetFiatMinor: bigint;
}

/**
 * Pure conversion engine. Rounds DOWN in crypto base units so the merchant can never
 * receive more than the fiat net amount supports. Rate is fiat per 1 crypto unit.
 */
export function convertFiatToCrypto(input: {
  fees: FiatFeeBreakdown;
  rate: Decimal;
  decimals: number;
}): ConversionResult {
  const { fees, rate, decimals } = input;
  if (!rate.isFinite() || rate.lte(0)) {
    throw err.unavailable('rate_unavailable', 'exchange rate is not valid.');
  }

  const grossMajor = new Decimal(fees.grossMinor.toString()).div(100);
  const netMajor = new Decimal(fees.merchantNetMinor.toString()).div(100);

  const grossCryptoBase = decimalToBaseUnits(grossMajor.div(rate), decimals, Decimal.ROUND_DOWN);
  const merchantNetBase = decimalToBaseUnits(netMajor.div(rate), decimals, Decimal.ROUND_DOWN);

  if (merchantNetBase <= 0n) {
    throw err.unprocessable('amount_too_small', 'converted amount rounds to zero.');
  }

  return { rate, grossCryptoBase, merchantNetBase, merchantNetFiatMinor: fees.merchantNetMinor };
}

/** Returns the absolute deviation between two rates in basis points. */
export function rateDeviationBps(previous: Decimal, current: Decimal): number {
  if (previous.lte(0)) return Number.POSITIVE_INFINITY;
  return current.minus(previous).abs().div(previous).mul(10_000).toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
}
