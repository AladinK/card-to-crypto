import { Decimal } from 'decimal.js';
import { err } from './errors.js';

// One global decimal configuration for the whole engine. Money is never a JS float.
Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -60, toExpPos: 80 });

export const FIAT_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'RSD'] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

export function isFiatCurrency(value: string): value is FiatCurrency {
  return (FIAT_CURRENCIES as readonly string[]).includes(value);
}

// All supported fiat currencies use 2 minor-unit decimals (ISO 4217).
const FIAT_DECIMALS = 2;
const AMOUNT_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

/** Parses "100", "100.5" or "100.50" into fiat minor units (cents). Strict, no floats. */
export function parseFiatAmount(amount: string): bigint {
  if (!AMOUNT_RE.test(amount)) {
    throw err.unprocessable('invalid_amount', 'amount must be a decimal string with at most 2 decimals.');
  }
  const [whole = '0', fraction = ''] = amount.split('.');
  const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, FIAT_DECIMALS));
  if (minor <= 0n) {
    throw err.unprocessable('invalid_amount', 'amount must be greater than zero.');
  }
  return minor;
}

/** Formats fiat minor units as a decimal string, e.g. 10050n -> "100.50". */
export function formatFiat(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const text = `${abs / 100n}.${(abs % 100n).toString().padStart(FIAT_DECIMALS, '0')}`;
  return negative ? `-${text}` : text;
}

export function fiatMinorToDecimal(minor: bigint): Decimal {
  return new Decimal(minor.toString()).div(100);
}

/** Converts a major-unit decimal to fiat minor units with the given rounding mode. */
export function decimalToFiatMinor(major: Decimal, rounding: Decimal.Rounding): bigint {
  return BigInt(major.mul(100).toDecimalPlaces(0, rounding).toFixed(0));
}

/** Converts a major-unit decimal (e.g. 1.5 USDC) to on-chain base units (e.g. 1500000n). */
export function decimalToBaseUnits(major: Decimal, decimals: number, rounding: Decimal.Rounding): bigint {
  return BigInt(major.mul(new Decimal(10).pow(decimals)).toDecimalPlaces(0, rounding).toFixed(0));
}

export function baseUnitsToDecimal(base: bigint, decimals: number): Decimal {
  return new Decimal(base.toString()).div(new Decimal(10).pow(decimals));
}
