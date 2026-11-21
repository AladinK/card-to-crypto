# Card-to-Crypto Direct Settlement (working name: CardCrypto)

Customers pay with a normal card checkout (Visa, Mastercard, Apple Pay, Google Pay). The platform converts the amount and the merchant receives USDC or USDT on its own wallet. The shopper never needs a wallet or crypto.

**Status: MVP, sandbox-complete. Live mode is intentionally disabled until the legal and treasury items in `docs/LEGAL_AND_TECHNICAL_DEPENDENCIES.md` are done.**

## What is in this repository

| Part | Path | State |
|---|---|---|
| Backend API + worker (Fastify, PostgreSQL, viem, Stripe SDK) | `backend/` | Implemented, tested |
| JavaScript/TypeScript SDK (`cryptoPay.checkout()`, webhook verification) | `sdk/` | Implemented, tested |
| Merchant dashboard (Next.js, BFF pattern) | `dashboard/` | Built by a separate work item; see its README |
| WooCommerce gateway | `plugins/woocommerce/` | Built by a separate work item; lint and harness tests only |
| Shopify app | `plugins/shopify/` | Built by a separate work item; partial, see its README |
| OpenAPI specification | `docs/openapi.yaml` (served at `/openapi.yaml`) | Core endpoints |
| Architecture, security, refund policy, deployment, legal dependencies | `docs/` | Written |
| Docker image and compose stack | `Dockerfile`, `docker-compose.yml` | Written; not built here (no Docker daemon) |
| Postman collection, checkout example | `postman/`, `examples/` | Written |

## Quick start (sandbox)

```bash
npm install
cp .env.example backend/.env          # then fill the secrets (see docs/DEPLOYMENT.md)
npm run migrate -w @cardcrypto/backend
npm run dev:api -w @cardcrypto/backend          # http://localhost:3000
npm run dev:worker -w @cardcrypto/backend       # second terminal
```

Create a merchant, create a test key, add and verify a settlement wallet, then create a payment:

```bash
curl -s localhost:3000/v1/auth/register -H 'content-type: application/json' \
  -d '{"merchant_name":"Demo","email":"demo@shop.test","password":"demo passphrase 123"}'
# Use the access_token to POST /v1/api-keys {"name":"server","mode":"test"}, then:
curl -s localhost:3000/v1/payments -H "authorization: Bearer $SK" -H 'idempotency-key: order-10482-try-1' \
  -H 'content-type: application/json' \
  -d '{"amount":"100.00","currency":"EUR","order_id":"ORDER-10482","return_url":"https://shop.test/thanks"}'
```

Open the returned `checkout_url`, choose the approved test card, and the settlement runs through the worker.

Or run the whole walkthrough against your running API and worker in one command (creates a fresh merchant each run):

```bash
API_URL=http://localhost:3000 npm run demo -w @cardcrypto/backend
```

## Test results

Run with `TEST_DATABASE_URL` pointing at a disposable PostgreSQL 16 database:

```bash
npm test -w @cardcrypto/backend     # vitest: unit, sandbox e2e, security, EVM on an in-process chain
npm test -w @cardcrypto/sdk        # build + node:test
npm run typecheck                  # tsc --noEmit for backend and sdk
```

Results from the last run in the authoring environment are recorded in `docs/TEST_RESULTS.md`.

## Architecture in one paragraph

Payment state is one state machine with an append-only transition log. Provider events are applied once (deduplicated in the same transaction). Settlement runs as a pipeline of short, idempotent steps: quote (30 s), conversion, transfer (the signed transaction is stored before broadcast, so a crash cannot pay twice), confirmations. Merchant webhooks go through a transactional outbox with signed, retried, dead-lettered delivery. Details: `docs/ARCHITECTURE.md`.

## Known limitations (MVP)

- No live money path is enabled. Stripe, the EVM adapter and the treasury signer are implemented but need production configuration, a KMS-backed signer, and compliance providers (fail-closed until then).
- Sanctions and AML providers are interfaces without a vendor integration; KYB is a manual admin decision.
- Refunds are in fiat. Crypto recovery is recorded but not netted automatically.
- Rate source is a public API for development only.
- Job queue is PostgreSQL-based; BullMQ/Redis is an option behind the same interface.
- No OpenTelemetry or Sentry integration yet; logs are structured JSON, metrics are exposed through the admin health endpoint only.
- Rate limiting is in-memory per instance.
- The Shopify and WooCommerce integrations are not verified against live platforms (see their READMEs).
- No penetration test has been performed.

See `docs/SECURITY.md` for the full control list and known gaps.
