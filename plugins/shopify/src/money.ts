/** Decimal amount with at most two fraction digits, as accepted by the Card-to-Crypto backend. */
const DECIMAL_AMOUNT = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** "100.5" -> 10050n. Returns null for anything that is not a plain non-negative decimal. */
export function toMinorUnits(decimal: string): bigint | null {
  const match = DECIMAL_AMOUNT.exec(decimal);
  if (!match) return null;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'));
  return whole * 100n + fraction;
}

/** 10050n -> "100.50". */
export function fromMinorUnits(minor: bigint): string {
  const whole = minor / 100n;
  const fraction = minor % 100n;
  return `${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
}

export function isDecimalAmount(value: string): boolean {
  return DECIMAL_AMOUNT.test(value);
}
