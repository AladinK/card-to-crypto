# Security model

## Scope
Backend API, worker, dashboard (BFF), SDK, plugins. Out of scope: the merchant's own website, the hosted checkout of the card processor (PCI controls belong to the processor), and the operator's cloud account.

## Controls

| Area | Control | Where |
|---|---|---|
| Passwords | scrypt (N=2^15, r=8, p=1), per-user salt, constant-time compare; 12-character minimum; lockout after 10 failures for 15 min | `core/security.ts`, `merchant/service.ts` |
| Sessions | Access JWT (HS256, 15 min, issuer/audience checked); opaque refresh token stored as SHA-256; rotation on every use; reuse of a rotated token revokes the family | `merchant/auth.ts`, `merchant/service.ts` |
| Two-factor | TOTP (RFC 6238), secret encrypted at rest, one-time use per time step (replay protection); required for live API key creation and for live actions in production | `core/security.ts`, `api/auth.ts` |
| API keys | `sk_<mode>_<16 hex>_<43 base64url>`; only HMAC-SHA256(pepper, key) is stored; revocation; rotation with a grace period (`expires_at`); last-used tracking | `merchant/service.ts` |
| OAuth | Shopify app: state cookie, HMAC on callback query, encrypted token storage (see `plugins/shopify`) | plugin |
| Authorization | Roles owner / admin / viewer; viewers are read-only; platform administrators are a separate flag; every merchant query is scoped by `merchant_id` | `merchant/auth.ts`, all services |
| Input validation | zod schemas with `.strict()` (unknown fields rejected), URL scheme allow-list (no `javascript:`), amount strings parsed without floats, body size limit 256 KB | `api/schemas.ts` |
| Idempotency | Mandatory `Idempotency-Key` for payments and refunds; deterministic payment and refund ids derived from the key; 422 on body mismatch | `idempotency/index.ts`, `payment-engine/service.ts` |
| Rate limiting | Global per credential (300/min), stricter on authentication (5–10/min) | `api/app.ts`, routes |
| Webhooks in | Provider signatures verified over the raw body (Stripe SDK; sandbox HMAC); events deduplicated by `(provider, event_id)`; amount, currency, session and payment reference checked before any state change | `payment-processors/*`, `payment-engine/service.ts` |
| Webhooks out | HMAC-SHA256 with timestamp; 300 s tolerance; secret encrypted at rest; HTTPS only (live); private and loopback targets refused at connect time; no redirects | `webhooks/outbound.ts`, `webhooks/net.ts` |
| Encryption at rest | AES-256-GCM with a 96-bit random IV and authenticated tag for webhook secrets and TOTP secrets (`DATA_ENCRYPTION_KEY`); plan: move the key to KMS | `core/security.ts` |
| Encryption in transit | TLS terminated at the load balancer (required, see DEPLOYMENT.md); HSTS via helmet | `api/app.ts` |
| Audit | Hash-chained audit log (`audit_logs`), each row covers the previous hash; UPDATE/DELETE rejected by trigger; verification endpoint for operators | `audit/audit.ts` |
| Wallet proof | EIP-191 personal signature over a one-time message with a 15-minute expiry; verified with viem | `wallet/service.ts`, `blockchain/evm.ts` |
| Settlement protection | Verified wallet + activation delay in live mode; sanctions screening at wallet registration and before every settlement; amount-review threshold; rate-deviation hold; KYB required; compliance fail-closed | `wallet/service.ts`, `compliance/index.ts`, `settlement/service.ts` |
| Merchant keys | No merchant private keys are stored. Settlement only needs the public address. | — |
| Treasury keys | Signer interface. The environment-key signer is refused in production unless `UNSAFE_ALLOW_ENV_SIGNER=true`. A KMS/HSM signer must be implemented for production. | `blockchain/signers.ts`, `config.ts` |
| Chain safety | Transfer amount verified from the Transfer log; treasury nonce serialized with an advisory lock; signed bytes persisted before broadcast (no double payout on crash) | `settlement/service.ts`, `blockchain/evm.ts` |
| Fraud | Explainable risk score; BLOCKED refused at checkout; HIGH held before capture; pluggable external signal | `risk/engine.ts`, `payment-engine/service.ts` |
| Logging | Structured JSON; route patterns logged (never query strings, which carry checkout tokens); redaction of authorization headers and secret fields | `logger.ts`, `api/app.ts` |
| Headers | helmet (strict CSP for the API), CORS allow-list for the dashboard origin, checkout pages with `default-src 'none'` and `frame-ancestors 'none'` | `api/app.ts`, `api/routes/checkout.ts` |
| Sandbox isolation | Sandbox provider events are refused in production; sandbox checkout links carry an HMAC token bound to the payment id | `api/routes/providers.ts`, `payment-processors/sandbox.ts` |

## Known gaps (must close before live money)
1. No independent penetration test yet.
2. Treasury signer: KMS/HSM implementation is required; the env signer is for staging only.
3. Sanctions and AML providers are not integrated: live settlements are held until they are (fail-closed by design).
4. Email verification and password breach checks are not implemented.
5. Rate limiting is in-process memory; use the Redis store of `@fastify/rate-limit` when running several API replicas.
6. TOTP secret encryption key rotation is not implemented (the payload has a version prefix to make it possible).
7. Dashboard CSRF protection relies on SameSite cookies and a custom header; review before launch.

## Reporting
Security issues: contact the operator privately. Do not open public issues with exploit details.
