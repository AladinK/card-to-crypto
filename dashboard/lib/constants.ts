/** Shared by server and browser code. Keep free of server-only imports. */

export const THEME_COOKIE = 'cc_theme';

/** Dispatched on the window when the API says the session is over. The session provider sends the user to sign in. */
export const SESSION_EXPIRED_EVENT = 'cc:session-expired';

export type Mode = 'test' | 'live';

/** Settlement pairs the API accepts. Mirrors backend/src/core/assets.ts (CHAINS[...].tokens). */
export const CHAINS = [
  { key: 'ethereum', label: 'Ethereum', assets: ['USDC', 'USDT'], explorer: 'https://etherscan.io', explorerName: 'Etherscan' },
  { key: 'polygon', label: 'Polygon PoS', assets: ['USDC', 'USDT'], explorer: 'https://polygonscan.com', explorerName: 'Polygonscan' },
  { key: 'base', label: 'Base', assets: ['USDC'], explorer: 'https://basescan.org', explorerName: 'Basescan' },
  { key: 'arbitrum', label: 'Arbitrum One', assets: ['USDC', 'USDT'], explorer: 'https://arbiscan.io', explorerName: 'Arbiscan' },
] as const;

export type ChainKey = (typeof CHAINS)[number]['key'];

export const CHAIN_BY_KEY: Record<string, (typeof CHAINS)[number] | undefined> = Object.fromEntries(
  CHAINS.map((chain) => [chain.key, chain]),
);

export const WEBHOOK_EVENTS = [
  'payment.created',
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'payment.cancelled',
  'conversion.completed',
  'settlement.created',
  'settlement.confirmed',
  'settlement.failed',
  'refund.created',
  'refund.completed',
  'refund.failed',
] as const;

export const REFUND_REASONS = [
  { value: 'requested_by_customer', label: 'Requested by customer' },
  { value: 'duplicate', label: 'Duplicate charge' },
  { value: 'fraudulent', label: 'Fraudulent' },
  { value: 'other', label: 'Other' },
] as const;

export const DELIVERY_STATUSES = ['PENDING', 'RETRYING', 'DELIVERED', 'DEAD'] as const;

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
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
] as const;
