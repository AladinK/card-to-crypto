-- Card-to-Crypto Direct Settlement: initial schema.
-- Conventions: text ids with prefixes (mer_, pay_, ...), money as BIGINT minor units (fiat cents)
-- and NUMERIC(78,0) base units for crypto. Append-only tables are protected by triggers.

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  country CHAR(2),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
  kyb_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (kyb_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  live_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  settlement_review_threshold_minor BIGINT NOT NULL DEFAULT 500000 CHECK (settlement_review_threshold_minor > 0),
  high_value_threshold_minor BIGINT NOT NULL DEFAULT 200000 CHECK (high_value_threshold_minor > 0),
  max_rate_deviation_bps INT NOT NULL DEFAULT 100 CHECK (max_rate_deviation_bps BETWEEN 0 AND 1000),
  order_paid_trigger TEXT NOT NULL DEFAULT 'PAYMENT_CAPTURED'
    CHECK (order_paid_trigger IN ('PAYMENT_CAPTURED', 'SETTLEMENT_CONFIRMED')),
  risk_thresholds JSONB NOT NULL DEFAULT '{"medium": 30, "high": 60, "blocked": 100}',
  fee_schedule JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants (id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret_enc TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last_step BIGINT,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (merchant_id IS NOT NULL OR is_platform_admin)
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  family_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users (id),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_id);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN
    ('shopify', 'woocommerce', 'magento', 'prestashop', 'bigcommerce', 'custom', 'headless')),
  domain TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  blockchain TEXT NOT NULL,
  asset TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UNVERIFIED', 'VERIFIED', 'DISABLED')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  verification_message TEXT,
  verification_expires_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, blockchain, asset, address)
);
CREATE UNIQUE INDEX wallets_one_default_idx ON wallets (merchant_id, blockchain, asset) WHERE is_default;

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  external_order_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('UNPAID', 'PENDING_PAYMENT', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, mode, external_order_id)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  order_id TEXT NOT NULL REFERENCES orders (id),
  store_id TEXT REFERENCES stores (id),
  status TEXT NOT NULL CHECK (status IN (
    'CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED', 'PAYMENT_CAPTURED', 'CONVERSION_PENDING',
    'CONVERSION_COMPLETED', 'CRYPTO_TRANSFER_PENDING', 'CRYPTO_TRANSFER_SUBMITTED', 'CRYPTO_CONFIRMING',
    'SETTLED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED')),
  provider TEXT NOT NULL,
  provider_session_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  checkout_url TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL,
  refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  payment_method TEXT,
  card_country CHAR(2),
  customer_email TEXT,
  description TEXT NOT NULL DEFAULT '',
  return_url TEXT NOT NULL,
  cancel_url TEXT NOT NULL,
  settlement_blockchain TEXT NOT NULL,
  settlement_asset TEXT NOT NULL,
  settlement_wallet_id TEXT NOT NULL REFERENCES wallets (id),
  risk_level TEXT CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'BLOCKED')),
  risk_score INT,
  metadata JSONB NOT NULL DEFAULT '{}',
  failure_reason TEXT,
  hold_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one open checkout per order (duplicate-payment protection enforced by the database).
CREATE UNIQUE INDEX payments_one_open_per_order_idx ON payments (merchant_id, mode, order_id)
  WHERE status IN ('CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED');
CREATE INDEX payments_merchant_created_idx ON payments (merchant_id, mode, created_at DESC);
CREATE INDEX payments_status_expires_idx ON payments (status, expires_at);
CREATE INDEX payments_customer_idx ON payments (merchant_id, customer_email, created_at DESC);

CREATE TABLE payment_transitions (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_transitions_payment_idx ON payment_transitions (payment_id, id);

CREATE TABLE payment_attempts (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  payment_id TEXT REFERENCES payments (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  fiat_amount_minor BIGINT NOT NULL CHECK (fiat_amount_minor > 0),
  fiat_currency CHAR(3) NOT NULL,
  asset TEXT NOT NULL,
  blockchain TEXT NOT NULL,
  rate NUMERIC(38, 18) NOT NULL CHECK (rate > 0),
  rate_source TEXT NOT NULL,
  gross_amount_base NUMERIC(78, 0) NOT NULL,
  merchant_net_base NUMERIC(78, 0) NOT NULL,
  fees JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX quotes_payment_idx ON quotes (payment_id, created_at DESC);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments (id),
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  blockchain TEXT NOT NULL,
  asset TEXT NOT NULL,
  to_address TEXT NOT NULL,
  from_address TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONVERTED', 'SUBMITTED', 'CONFIRMING', 'SETTLED', 'FAILED')),
  quote_id TEXT REFERENCES quotes (id),
  rate NUMERIC(38, 18),
  gross_amount_base NUMERIC(78, 0),
  amount_base NUMERIC(78, 0),
  fees JSONB,
  network_fee_fiat_minor BIGINT,
  nonce BIGINT,
  signed_tx TEXT,
  tx_hash TEXT UNIQUE,
  block_number BIGINT,
  confirmations INT NOT NULL DEFAULT 0,
  required_confirmations INT,
  hold BOOLEAN NOT NULL DEFAULT FALSE,
  hold_reason TEXT,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlements_status_idx ON settlements (status, hold);
CREATE INDEX settlements_merchant_idx ON settlements (merchant_id, mode, created_at DESC);

CREATE TABLE conversions (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  settlement_id TEXT NOT NULL REFERENCES settlements (id),
  quote_id TEXT NOT NULL REFERENCES quotes (id),
  rate NUMERIC(38, 18) NOT NULL,
  crypto_amount_base NUMERIC(78, 0) NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  reason TEXT,
  provider_refund_id TEXT UNIQUE,
  original_settlement_id TEXT REFERENCES settlements (id),
  original_crypto_amount_base NUMERIC(78, 0),
  original_asset TEXT,
  -- Crypto is never auto-reversed. A refund creates an OPEN recovery: the merchant owes the
  -- fiat-equivalent of crypto already settled for the refunded part (see docs/REFUND_POLICY.md).
  crypto_recovery_status TEXT NOT NULL DEFAULT 'NONE' CHECK (crypto_recovery_status IN ('NONE', 'OPEN', 'RECOVERED')),
  crypto_recovery_fiat_minor BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);

CREATE TABLE provider_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE idempotency_keys (
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, idem_key)
);

CREATE TABLE jobs (
  id BIGSERIAL PRIMARY KEY,
  queue TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 12,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_dedupe_queued_idx ON jobs (dedupe_key) WHERE status = 'queued' AND dedupe_key IS NOT NULL;
CREATE INDEX jobs_ready_idx ON jobs (status, run_at);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  type TEXT NOT NULL,
  payment_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_merchant_idx ON webhook_events (merchant_id, created_at DESC);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES webhook_events (id),
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints (id),
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'RETRYING', 'DEAD')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code INT,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_merchant_idx ON webhook_deliveries (merchant_id, created_at DESC);
CREATE INDEX webhook_deliveries_status_idx ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE webhook_attempts (
  id BIGSERIAL PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries (id),
  attempt_no INT NOT NULL,
  status_code INT,
  duration_ms INT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  merchant_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_merchant_idx ON audit_logs (merchant_id, id DESC);

CREATE TABLE risk_events (
  id BIGSERIAL PRIMARY KEY,
  merchant_id TEXT,
  payment_id TEXT,
  stage TEXT NOT NULL,
  score INT NOT NULL,
  level TEXT NOT NULL,
  reasons JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_events_payment_idx ON risk_events (payment_id);

CREATE TABLE platform_flags (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exchange_rate_snapshots (
  id BIGSERIAL PRIMARY KEY,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  rate NUMERIC(38, 18) NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only guarantees: audit trail, payment transition log, webhook attempts, risk events.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER payment_transitions_append_only BEFORE UPDATE OR DELETE ON payment_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER webhook_attempts_append_only BEFORE UPDATE OR DELETE ON webhook_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER risk_events_append_only BEFORE UPDATE OR DELETE ON risk_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
