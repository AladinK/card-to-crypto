import { CHAIN_BY_KEY } from './constants';

/*
 * Money rule: amounts arrive as decimal strings and are shown as they arrived. Grouping separators are added
 * as text, so no value passes through floating point. Durations and percentages may use numbers.
 */

const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

export function formatDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (!DECIMAL.test(value)) return value;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '', fraction] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction !== undefined ? `.${fraction}` : ''}`;
}

export function formatAmount(value: string | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return currency ? `${formatDecimal(value)} ${currency}` : formatDecimal(value);
}

/** Converts integer minor units (cents) to a decimal string by moving the decimal point. No arithmetic. */
export function formatMinorUnits(minor: string | null | undefined, decimals = 2): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  if (!INTEGER.test(minor)) return minor;
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals);
  return `${negative ? '-' : ''}${formatDecimal(whole)}.${fraction}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const DATE_ONLY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_ONLY.format(date);
}

export function truncateMiddle(value: string | null | undefined, head = 8, tail = 6): string {
  if (!value) return '—';
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function explorerTxUrl(blockchain: string | null | undefined, hash: string | null | undefined): string | null {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const chain = blockchain ? CHAIN_BY_KEY[blockchain] : undefined;
  return chain ? `${chain.explorer}/tx/${hash}` : null;
}

export function explorerName(blockchain: string | null | undefined): string | null {
  const chain = blockchain ? CHAIN_BY_KEY[blockchain] : undefined;
  return chain ? chain.explorerName : null;
}

/** "PAYMENT_PENDING" -> "Payment pending", "sandbox_card" -> "Sandbox card". */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'test' | 'live';

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'SETTLED':
    case 'DELIVERED':
    case 'VERIFIED':
    case 'ACTIVE':
    case 'APPROVED':
    case 'SUCCEEDED':
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
    case 'DEAD':
    case 'REJECTED':
    case 'FROZEN':
    case 'CLOSED':
    case 'ON_HOLD':
      return 'danger';
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'OPEN':
      return 'info';
    case 'PENDING':
    case 'RETRYING':
    case 'UNVERIFIED':
    case 'CREATED':
    case 'PAYMENT_PENDING':
    case 'PAYMENT_AUTHORIZED':
    case 'PAYMENT_CAPTURED':
    case 'CONVERSION_PENDING':
    case 'CONVERSION_COMPLETED':
    case 'CRYPTO_TRANSFER_PENDING':
    case 'CRYPTO_TRANSFER_SUBMITTED':
    case 'CRYPTO_CONFIRMING':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Short ISO-style period label for the date range control, in UTC. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
