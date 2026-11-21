import { err } from './errors.js';

/**
 * Single payment + crypto-settlement state machine (see docs/ARCHITECTURE.md).
 * Every transition is validated here; the database log is append-only.
 */
export const PAYMENT_STATUSES = [
  'CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_CAPTURED',
  'CONVERSION_PENDING',
  'CONVERSION_COMPLETED',
  'CRYPTO_TRANSFER_PENDING',
  'CRYPTO_TRANSFER_SUBMITTED',
  'CRYPTO_CONFIRMING',
  'SETTLED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'CANCELLED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ['PAYMENT_PENDING', 'FAILED', 'CANCELLED'],
  PAYMENT_PENDING: ['PAYMENT_AUTHORIZED', 'PAYMENT_CAPTURED', 'FAILED', 'CANCELLED'],
  PAYMENT_AUTHORIZED: ['PAYMENT_CAPTURED', 'FAILED', 'CANCELLED'],
  PAYMENT_CAPTURED: ['CONVERSION_PENDING'],
  CONVERSION_PENDING: ['CONVERSION_COMPLETED', 'FAILED'],
  CONVERSION_COMPLETED: ['CRYPTO_TRANSFER_PENDING', 'FAILED'],
  CRYPTO_TRANSFER_PENDING: ['CRYPTO_TRANSFER_SUBMITTED', 'FAILED'],
  // Back to pending only when the signed transaction was provably dropped (its nonce was consumed elsewhere).
  CRYPTO_TRANSFER_SUBMITTED: ['CRYPTO_CONFIRMING', 'CRYPTO_TRANSFER_PENDING', 'FAILED'],
  CRYPTO_CONFIRMING: ['SETTLED', 'FAILED'],
  SETTLED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  // FAILED after capture = settlement failed; an operator may retry it (guarded in the service).
  FAILED: ['CONVERSION_PENDING'],
  REFUNDED: [],
  CANCELLED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw err.conflict('invalid_state_transition', `Cannot move payment from ${from} to ${to}.`, { from, to });
  }
}

/** Statuses in which the customer's money has been captured by the provider. */
const CAPTURED_OR_LATER: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  'PAYMENT_CAPTURED',
  'CONVERSION_PENDING',
  'CONVERSION_COMPLETED',
  'CRYPTO_TRANSFER_PENDING',
  'CRYPTO_TRANSFER_SUBMITTED',
  'CRYPTO_CONFIRMING',
  'SETTLED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

export function isCaptured(status: PaymentStatus): boolean {
  return CAPTURED_OR_LATER.has(status);
}

/** Statuses that still hold an "open" checkout for an order (one per order at a time). */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED'];
