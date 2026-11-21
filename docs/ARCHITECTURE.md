# Architecture

## 1. Overview

```
 Shopper ──card──▶ Hosted checkout (Stripe in live, sandbox page in test)
                        │ authorization / capture events (signed webhooks)
                        ▼
 Merchant shop ──▶ CardCrypto API (Fastify) ──▶ PostgreSQL (state, audit, jobs, outbox)
   (plugin/SDK)          │                              ▲
                         │ enqueue (same transaction)   │ claim (SKIP LOCKED)
                         ▼                              │
                    CardCrypto worker ── settlement pipeline ──▶ Rate source (CoinGecko live / fixed sandbox)
                         │                                    ──▶ EVM RPC (viem, failover)  ──▶ Treasury signer (KMS in prod)
                         ▼
                 Outbound webhooks (signed, retried, dead-lettered) ──▶ Merchant backend
 Merchant dashboard (Next.js BFF; refresh token in httpOnly cookie) ──▶ API
```

Modes: every API key has a mode. `sk_test_` uses sandbox adapters (fake card, fake chain, fake money).
`sk_live_` uses real adapters and is refused at boot unless live configuration (Stripe, RPC, treasury signer) is present.

## 2. Components (backend/src)

| Folder | Responsibility |
|---|---|
| `core/` | Money (integer cents, decimal.js for rates), fee engine, conversion engine (rounds down in base units), state machine, security primitives (scrypt, AES-256-GCM, TOTP, HMAC webhook signatures, API key format), asset/chain registry |
| `payment-engine/` | Payment creation, idempotent order reservation, risk gate, provider event ingestion with dedupe, refunds, capture/void jobs, expiry sweep |
| `payment-processors/` | `PaymentProvider` interface; `StripePaymentProvider` (hosted Checkout, manual capture); `SandboxPaymentProvider` |
| `crypto-engine/` | Rate providers (`CoinGeckoRateProvider`, `SandboxRateProvider`), quote service (30 s TTL, fee breakdown) |
| `blockchain/` | `BlockchainAdapter` interface; `EvmBlockchainAdapter` (viem, EIP-1559 ERC-20 transfers, receipts, Transfer-log verification); `SandboxChainAdapter` |
| `settlement/` | Settlement pipeline: quote → conversion → transfer (sign, persist, broadcast) → submitted check → confirmations → SETTLED |
| `wallet/` | Settlement wallet registry, EIP-191 ownership proof, activation delay, default selection |
| `merchant/` | Registration, login with TOTP and refresh-token rotation, API keys (rotation with grace period), stores, RBAC helpers |
| `compliance/` | `KycProvider`, `SanctionsProvider`, `AmlProvider`, `FraudProvider`; `ComplianceEngine` is fail-closed |
| `risk/` | Explainable scoring (velocity, failures, value, disposable email, IP reputation, processor risk, country mismatch) → LOW/MEDIUM/HIGH/BLOCKED |
| `webhooks/` | Transactional outbox for merchant events, signed delivery with exponential backoff, DLQ, replay; SSRF-safe HTTP client |
| `jobs/` | PostgreSQL job queue (`FOR UPDATE SKIP LOCKED`), worker loop, maintenance (stale jobs, expiry, reconciliation, retention) |
| `audit/` | Hash-chained audit log (append-only by trigger); `verifyAuditChain()` |
| `idempotency/` | Idempotency-Key store: replay, 422 on body mismatch, 409 while in progress |
| `api/` | Fastify application, zod validation (strict schemas), auth resolution, error envelope, rate limits, security headers |
| `checkout/` routes | Sandbox hosted checkout and return bridge |

Entry points: `server.ts` (API), `worker.ts` (job worker), `db/migrate-cli.ts` (migrations).

## 3. Payment state machine

```
CREATED → PAYMENT_PENDING → PAYMENT_AUTHORIZED → PAYMENT_CAPTURED → CONVERSION_PENDING
        → CONVERSION_COMPLETED → CRYPTO_TRANSFER_PENDING → CRYPTO_TRANSFER_SUBMITTED
        → CRYPTO_CONFIRMING → SETTLED → PARTIALLY_REFUNDED → REFUNDED
Terminal/side exits: FAILED (before capture: provider failure or decline; after capture: settlement failed, operator may retry),
                     CANCELLED (checkout abandoned, expired, or authorization voided after review)
```

Rules enforced in code (`core/states.ts`, `payment-engine/repo.ts`):
- Only listed transitions are allowed; every transition is written to the append-only `payment_transitions` table.
- The order becomes `PAID` only when the payment is captured (default) or settlement is confirmed (merchant setting `order_paid_trigger`). An order is never PAID while the payment is unconfirmed.
- Provider events are applied at most once: `provider_events` has a primary key on `(provider, event_id)` and rows are written in the same transaction as the state change.
- An event whose amount, currency, provider session or provider payment reference does not match the payment is recorded and ignored; the payment is held for review (`AMOUNT_MISMATCH`).

## 4. Payment flow (card side)

1. Merchant calls `POST /v1/payments` with `Idempotency-Key`. The API reserves the order, runs the pre-checkout risk gate (BLOCKED is refused), inserts the payment as `CREATED`, creates the hosted checkout, and moves the payment to `PAYMENT_PENDING`. The `payment.created` event is emitted in the same transaction.
2. The shopper pays on the hosted checkout. The provider sends an authorization event (signed webhook; sandbox: the checkout page).
3. The engine moves the payment to `PAYMENT_AUTHORIZED` and enqueues a capture job. High-risk payments are held (not captured) for review.
4. The capture job captures the authorization (idempotency key per payment) and applies the captured event → `PAYMENT_CAPTURED` → `CONVERSION_PENDING`. The settlement row is created, the order is PAID (default), and `payment.captured` and `settlement.created` are emitted.
5. Abandoned checkouts expire (`CANCELLED`) through the maintenance sweep.

## 5. Crypto settlement flow

1. **Conversion**: the engine checks that the settlement is not on hold (wallet verified and active, KYB approved, sanctions and AML providers passed, amount below the review threshold, rate movement within the merchant limit). It creates a quote: rate from the rate source, network fee estimate in fiat, fee breakdown, `expires_at = now + 30 s`. If the quote is still valid on the next step, it is executed: `merchant_net_crypto = floor((gross − fees) / rate)` in base units. If it expired, a new quote is created and the rate movement is compared with the previous quote (deviation above the limit → hold `RATE_DEVIATION`).
2. **Transfer, phase 1 (database transaction)**: pre-checks treasury token balance (`INSUFFICIENT_LIQUIDITY` → retry later) and native gas balance with 20% headroom (`INSUFFICIENT_GAS` → retry later). Under an advisory lock on the treasury address, the nonce is chosen as max(chain pending nonce, last nonce in the database + 1). The EIP-1559 ERC-20 `transfer` is signed by the signer and the **signed bytes are stored before broadcast**.
3. **Transfer, phase 2**: broadcast of the stored bytes. Rebroadcasting is idempotent; if the transaction is already known or mined, the adapter reports it as submitted.
4. **Submitted**: receipt status. `pending` → wait. `not_found` → rebroadcast the same bytes; if the nonce was consumed by someone else, the transfer is signed again with a fresh nonce. `reverted` → `FAILED`. Success → the Transfer log must show the expected amount to the merchant wallet, otherwise `TRANSFER_MISMATCH` → `FAILED`.
5. **Confirmations**: wait for the configured depth (defaults: Ethereum 12, Polygon 128, Base 10, Arbitrum 10). Then `SETTLED`, `settlement.confirmed` is emitted with `tx_hash`, and the order is PAID if the merchant chose settlement-based payment.

Failures after capture leave the order PAID (money was captured). `FAILED` settlements are retried by an operator (`POST /v1/admin/settlements/{id}/retry`), which re-quotes and signs with a fresh nonce.

## 6. Webhooks (merchant side)

- Events are written with the business change (transactional outbox) and one delivery per matching endpoint.
- Header `CardCrypto-Signature: t=<unix>,v1=<hmac>`; receivers reject timestamps older than 300 seconds and deduplicate on `id`.
- Retries: 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h (10 attempts). Then `DEAD` (dead-letter). Operators and merchants can replay a delivery.
- Destinations: HTTPS only in live mode. Private, loopback and link-local addresses are refused at connect time (`lookup` hook), which also defeats DNS rebinding. Redirects are not followed.

## 7. Database

Tables (see `backend/migrations/001_init.sql`):

| Table | Purpose |
|---|---|
| merchants, users, auth_sessions, api_keys, stores | Accounts, RBAC role per user, refresh-token families, hashed API keys |
| wallets | Settlement destinations with verification state and default flag (one default per chain and asset) |
| orders | Merchant order, status PAID/REFUNDED/… (unique per merchant, mode and external id) |
| payments, payment_transitions, payment_attempts | Payment state with an append-only transition log |
| quotes, conversions, settlements | Rate quotes (30 s), executed conversions, on-chain transfer state (signed bytes, nonce, hash, confirmations, hold) |
| refunds | Fiat refunds with crypto-recovery status (`OPEN` when a settled crypto amount must be recovered) |
| provider_events | Inbound provider events, deduplicated by `(provider, event_id)` |
| idempotency_keys | Replay store for Idempotency-Key (24 h) |
| jobs | PostgreSQL job queue (dedupe key, attempts, backoff, dead state) |
| webhook_endpoints, webhook_events, webhook_deliveries, webhook_attempts | Outbound events, deliveries, attempt log |
| audit_logs | Hash-chained audit trail; UPDATE and DELETE are rejected by trigger |
| risk_events | Explainable risk decisions (append-only) |
| platform_flags, exchange_rate_snapshots | Operator switches (e.g. disable a chain), rate history |

Money: fiat as `BIGINT` cents, crypto as `NUMERIC(78,0)` base units, rates as `NUMERIC(38,18)`. No floats anywhere.

## 8. Key decisions and trade-offs

- **Fastify over NestJS**: smaller surface, faster to audit; the domain code is framework-independent.
- **PostgreSQL job queue instead of Redis + BullMQ**: business state, events and jobs must commit atomically. With a separate queue you need an outbox publisher, which is extra moving parts. BullMQ can be added behind the `jobs/queue.ts` interface when throughput requires it.
- **Manual capture**: lets risk review hold funds before capture. Authorizations that are not captured expire with the card network.
- **Hosted checkout only**: no card data touches our servers (PCI scope SAQ A for the hosted flow).
- **Sandbox in the same deployment**: test keys route to sandbox adapters. Sandbox money never leaves the process and sandbox transactions are labelled by mode in every table.
- **Dashboard as a backend-for-frontend**: the refresh token stays in an httpOnly cookie, the browser never holds an access token.

## 9. Folder structure

```
card-to-crypto/
  backend/            API, worker, engine (TypeScript)
    migrations/       SQL migrations (append-only rules in 001_init.sql)
    src/              modules listed in section 2
    test/             unit, integration (sandbox e2e, security, EVM on an in-process chain)
  sdk/                @cardcrypto/sdk: server client, webhook verification, cryptoPay.checkout()
  dashboard/          Next.js merchant dashboard (BFF pattern)
  plugins/
    woocommerce/      WordPress/WooCommerce gateway
    shopify/          Shopify app (OAuth, webhooks, order sync)
  docs/               this documentation, OpenAPI specification, legal and technical dependencies
  examples/           minimal integration examples
  postman/            Postman collection
```
