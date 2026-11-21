/** Response shapes exactly as the API returns them (snake_case). Money fields are decimal strings. */

import type { Mode } from './constants';

export interface MerchantInfo {
  id: string;
  name: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  kyb_status: 'PENDING' | 'APPROVED' | 'REJECTED';
  live_enabled: boolean;
}

export interface UserInfo {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'viewer';
  mfa_enabled: boolean;
  platform_admin: boolean;
}

/** GET /api/session (BFF). */
export interface SessionInfo {
  user: UserInfo;
  merchant: MerchantInfo | null;
  mode: Mode;
  liveEnabled: boolean;
}

export interface AnalyticsSummary {
  period: { from: string; to: string };
  mode: Mode;
  revenue: Array<{ currency: string; amount: string; captured_count: number }>;
  payments: { total: number; failed: number; cancelled: number; open: number };
  orders: { paid: number };
  settlements: {
    pending: number;
    completed: number;
    failed: number;
    on_hold: number;
    average_seconds_from_capture: number | null;
  };
  refunds: Array<{ currency: string; count: number; amount: string; open_crypto_recovery: string }>;
  fees: { payment: string; conversion: string; platform: string; blockchain_network: string; currency_note: string };
  exchange_rates: Array<{ asset: string; fiat_currency: string; rate: string; source: string; as_of: string }>;
}

export interface TransactionRow {
  payment_id: string;
  order_id: string;
  customer_amount: string;
  currency: string;
  payment_method: string | null;
  payment_status: string;
  refunded_amount: string;
  crypto_asset: string;
  crypto_amount: string | null;
  exchange_rate: string | null;
  payment_fee: string | null;
  conversion_fee: string | null;
  platform_fee: string | null;
  network_fee: string | null;
  merchant_received: string | null;
  wallet_address: string | null;
  blockchain: string | null;
  transaction_hash: string | null;
  settlement_status: string | null;
  timestamp: string;
  settled_at: string | null;
}

export interface PaymentDetail {
  id: string;
  mode: Mode;
  status: string;
  order_id: string;
  amount: string;
  amount_minor: string;
  currency: string;
  refunded_amount: string;
  description: string;
  payment_method: string | null;
  customer: { email: string | null };
  checkout_url: string;
  settlement: { blockchain: string; asset: string; wallet_id: string; wallet_address: string | null };
  risk_level: string | null;
  hold_reason: string | null;
  failure_reason: string | null;
  metadata: Record<string, string>;
  created_at: string;
  expires_at: string;
  captured_at: string | null;
}

/** Fee values are integer strings in fiat minor units (cents), not decimal strings. See README. */
export interface SettlementDetail {
  payment_id: string;
  status: string;
  hold?: boolean;
  hold_reason?: string | null;
  blockchain?: string;
  asset?: string;
  wallet_address?: string | null;
  exchange_rate?: string | null;
  rate_source?: string | null;
  crypto_amount?: string | null;
  merchant_received?: string | null;
  fees?: Record<string, string> | null;
  network_fee?: string | null;
  transaction_hash?: string | null;
  confirmations?: number;
  required_confirmations?: number;
  last_error?: string | null;
  submitted_at?: string | null;
  confirmed_at?: string | null;
}

export interface Refund {
  id: string;
  payment_id: string;
  status: string;
  amount: string;
  currency: string;
  reason: string;
  provider_refund_id: string | null;
  crypto_recovery: { status: string | null; amount: string; note: string };
  created_at: string;
}

export interface Wallet {
  id: string;
  blockchain: string;
  asset: string;
  address: string;
  status: 'UNVERIFIED' | 'VERIFIED' | 'DISABLED';
  is_default: boolean;
  verified_at: string | null;
  usable_for_settlement: boolean;
  verification_expires_at: string | null;
  created_at: string;
}

export interface WalletCreated extends Wallet {
  verification: { message: string; expires_at: string; instructions: string };
}

export interface ApiKey {
  id: string;
  name: string;
  mode: Mode;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** Returned once, on create and rotate. */
export interface ApiKeySecret {
  id: string;
  name: string;
  mode: Mode;
  key_prefix: string;
  secret: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  status: 'ACTIVE' | 'DISABLED';
  mode: Mode;
  created_at: string;
}

/** Returned once, on create and rotate-secret. */
export interface WebhookSecret {
  id: string;
  secret: string;
}

export interface DeliverySummary {
  id: string;
  event: string;
  payment_id: string | null;
  endpoint_url: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface DeliveryDetail {
  id: string;
  event: string;
  status: string;
  attempts: number;
  payload: unknown;
  attempt_log: Array<{
    attempt_no: number;
    status_code: number | null;
    duration_ms: number | null;
    error: string | null;
    created_at: string;
  }>;
  created_at: string;
}

export interface MfaSetup {
  secret: string;
  otpauth_uri: string;
}
