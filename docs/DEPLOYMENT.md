# Deployment

## 1. Local development (sandbox, no real money)

Prerequisites: Node.js 22, PostgreSQL 16, npm 10.

```bash
npm install                                  # installs backend and sdk workspaces
cp .env.example backend/.env                 # fill JWT_SECRET, API_KEY_PEPPER, DATA_ENCRYPTION_KEY, DATABASE_URL
createdb cardcrypto_dev                      # or use the compose stack below
npm run migrate -w @cardcrypto/backend       # applies backend/migrations
npm run dev:api -w @cardcrypto/backend       # API on :3000 (uses backend/.env)
npm run dev:worker -w @cardcrypto/backend    # job worker (second terminal)
```

Generate secrets:

```bash
openssl rand -hex 32      # JWT_SECRET, API_KEY_PEPPER
openssl rand -base64 32   # DATA_ENCRYPTION_KEY
```

Sandbox checkout test cards (hosted page at `/checkout/sandbox/...`):

| Card | Result |
|---|---|
| 4242 4242 4242 4242 | approved |
| 4000 0000 0000 0002 | declined |
| 4000 0000 0000 9995 | declined (insufficient funds) |

Sandbox settlement: any verified EVM address can be used as wallet. Transfers are simulated (3 confirmations, about 2 seconds). Test wallets: use any key you generate, for example `privateKeyToAccount(generatePrivateKey())` from `viem/accounts`, and sign the returned verification message.

Dashboard: `cd dashboard && npm install && API_BASE_URL=http://localhost:3000 npm run dev` (port 3001).

Run the tests: `TEST_DATABASE_URL=postgres://… npm test -w @cardcrypto/backend`. The test database is dropped and recreated on each test file; never point it at a real database.

## 2. Docker (staging)

```bash
cp .env.example .env          # set POSTGRES_PASSWORD, secrets, DATABASE_URL is set by compose
docker compose up --build
```

Services: `postgres`, `migrate` (one-shot), `api` (port 3000), `worker`. Health: `GET /healthz`, `GET /readyz`.

Not verified in the authoring environment: no Docker daemon was reachable there. Run `docker compose config` and a smoke test before relying on it.

## 3. Production checklist

Before any live payment:

1. **Legal and licensing** (see `LEGAL_AND_TECHNICAL_DEPENDENCIES.md`): regulatory status for crypto transfer services in each market, acquirer approval for the merchant category, AML programme, sanctions screening provider, Travel Rule solution, terms of service, refund policy signed off.
2. **Compliance providers**: implement `SanctionsProvider` and `AmlProvider` (and a KYB workflow beyond the admin decision). Until then `ComplianceEngine` holds every live settlement (fail-closed).
3. **Treasury signer**: implement a KMS or HSM backed `Signer` (AWS KMS with secp256k1, GCP Cloud KMS, or an MPC provider). The environment-key signer is refused in production unless `UNSAFE_ALLOW_ENV_SIGNER=true`, which is for staging only. Fund the treasury address with USDC on each active chain and monitor balances.
4. **Stripe**: live keys, webhook endpoint `https://<api>/webhooks/providers/stripe` subscribed to `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_failed`, `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `refund.updated`, `refund.failed`. Enable Apple Pay and Google Pay in the Stripe dashboard.
5. **RPC**: at least two providers per chain (`RPC_URLS_*` is comma-separated; viem fails over). Set `CONFIRMATIONS_*` to your risk policy.
6. **Rate source**: replace the public CoinGecko tier with a contracted price feed (SLA, rate limits).
7. **TLS and proxy**: terminate TLS at the load balancer, set `TRUST_PROXY=true` only behind it, enforce HSTS.
8. **Database**: managed PostgreSQL 16 with PITR backups, a role without UPDATE/DELETE on `audit_logs`, `payment_transitions`, `webhook_attempts` and `risk_events` (the triggers also block it), `statement_timeout` as configured.
9. **Secrets**: store `JWT_SECRET`, `API_KEY_PEPPER`, `DATA_ENCRYPTION_KEY`, Stripe keys in a secret manager; rotate `JWT_SECRET` by deploying a new value (sessions expire within the access token TTL plus refresh TTL).
10. **Observability**: ship the JSON logs; alert on: `jobs.dead` > 0, `settlements_on_hold` growing, `dead_webhook_deliveries` > 0, treasury balance below threshold, readiness failures, p95 latency, payment failure rate. OpenTelemetry and Sentry hooks are not wired in this release.
11. **Load**: run at least 2 API replicas and 2 workers. Rate limiting is per-instance memory; switch to a shared store first.
12. **Penetration test** and a review of the dashboard BFF before opening live mode to merchants.
13. **Env flags**: `LIVE_MODE_ENABLED=true` only after the above. `REQUIRE_MFA_FOR_LIVE=true` (default). `WEBHOOK_ALLOW_PRIVATE_TARGETS` must stay `false` (the process refuses to start otherwise in production).

## 4. Operations

- Migrations: `node backend/dist/db/migrate-cli.js` as a one-off job before rolling out new API or worker versions. Migrations are forward-only; never edit an applied migration.
- Dead jobs: `GET /v1/admin/jobs?status=dead`, fix the cause, then `POST /v1/admin/jobs/{id}/requeue`.
- Stuck settlement: `GET /v1/admin/health`, inspect `GET /v1/payments/{id}/settlement` (last_error, hold_reason). Release a hold with `POST /v1/admin/settlements/{paymentId}/release`, or retry a failed one with `POST /v1/admin/settlements/{paymentId}/retry`.
- Authorized but held payment (risk review): `POST /v1/admin/payments/{id}/release` captures, `POST /v1/admin/payments/{id}/reject` voids the authorization.
- Disable a chain for new settlements: `POST /v1/admin/flags` with `{"key":"chain:polygon","value":{"disabled":true}}`.
- Audit trail: `GET /v1/admin/audit-logs/verify` must return `ok: true`. A failure means a row was altered; treat it as an incident.
