-- Shopify plugin schema (applied by src/db/migrate.ts, tracked in schema_migrations).

-- One row per installed shop. The Admin API access token is stored only encrypted
-- (AES-256-GCM, format v1.<iv>.<tag>.<ciphertext>, see src/crypto/token-crypto.ts).
CREATE TABLE shops (
  shop_domain      text PRIMARY KEY CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  access_token_enc text NOT NULL,
  scopes           text NOT NULL,
  installed_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Shopify order -> Card-to-Crypto payment mapping.
CREATE TABLE orders_map (
  shop_domain      text NOT NULL REFERENCES shops (shop_domain) ON DELETE CASCADE,
  shopify_order_id text NOT NULL CHECK (shopify_order_id ~ '^[0-9]{1,20}$'),
  order_name       text NOT NULL,
  currency         text NOT NULL,
  amount           text NOT NULL,
  payment_id       text NOT NULL UNIQUE,
  checkout_url     text NOT NULL,
  payment_status   text NOT NULL DEFAULT 'created',
  marked_paid_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_domain, shopify_order_id)
);

-- Inbound webhook ledger used for dedupe. 'processing' rows are claims that are
-- released on failure and reclaimed when stale; 'done' rows are final.
CREATE TABLE processed_webhooks (
  source     text NOT NULL CHECK (source IN ('shopify', 'cardcrypto')),
  event_id   text NOT NULL,
  topic      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('processing', 'done')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);
