# Card-to-Crypto Shopify plugin (MVP)

A Node 22 + TypeScript Shopify app that connects a store to the Card-to-Crypto backend:

1. OAuth install (`/auth`, `/auth/callback`). The access token is stored encrypted (AES-256-GCM).
2. `orders/create` webhook creates a Card-to-Crypto payment for the order and stores the mapping.
3. Customers pay through a link, `GET /pay/:orderId?shop=...`, which redirects to the backend checkout.
4. A signed `payment.captured` webhook from Card-to-Crypto calls the Admin GraphQL mutation `orderMarkAsPaid`.

**This is not a native Shopify checkout integration.** See "Checkout" below.

## Layout

```
migrations/001_init.sql     shops, orders_map, processed_webhooks (applied at startup)
src/config.ts               env validation (names only in errors, never values)
src/crypto/hmac.ts          OAuth callback HMAC, Shopify webhook HMAC, CardCrypto-Signature, state cookie
src/crypto/token-crypto.ts  AES-256-GCM for access tokens (shop domain bound as AAD)
src/shopify/                shop validation, OAuth URLs and token exchange, orderMarkAsPaid, order -> payment plan
src/cardcrypto/client.ts    POST /v1/payments
src/handlers/               OAuth, Shopify webhooks, CardCrypto webhooks, /pay, /return, /healthz
src/db/                     pg store (dedupe ledger, mappings) and migration runner
test/                       node:test suites (see "Tests")
```

## Shopify Partner app setup

1. Create an app in the Partner dashboard (use a development store for testing).
2. **App URL:** your `APP_URL`, for example `https://shopify.example.com`.
3. **Allowed redirection URL:** `${APP_URL}/auth/callback` (must match exactly).
4. **Scopes:** `read_orders,write_orders`.
5. Copy the Client ID and Client secret into `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`.
6. **Webhook subscription (not created by this code):** subscribe `orders/create` to
   `${APP_URL}/webhooks/shopify/orders-create`. Use `shopify.app.toml` or the Admin API. Verify
   the mechanism against current Shopify documentation.
7. Install on the dev store by opening `${APP_URL}/auth?shop=<store>.myshopify.com` while logged in.

## Database

```sh
su postgres -c "createdb -O cardcrypto cardcrypto_shopify"
```

Migrations run automatically at startup and are tracked in `schema_migrations`. Each migration runs
in a transaction under an advisory lock.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `APP_URL` | yes | Public origin. `https`, or `http` for localhost or 127.0.0.1 only. |
| `PORT` | no | Default 3000. |
| `DATABASE_URL` | yes | PostgreSQL connection string for `cardcrypto_shopify`. |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | yes | Partner app credentials. The secret also verifies webhooks. |
| `SHOPIFY_SCOPES` | no | Default `read_orders,write_orders`; must include both. |
| `SHOPIFY_API_VERSION` | no | Default `2026-10` (see "Not verified"). |
| `SHOPIFY_TIMEOUT_MS` | no | Default 8000. |
| `TOKEN_ENCRYPTION_KEY` | yes | Base64 of exactly 32 bytes: `openssl rand -base64 32`. |
| `COOKIE_SECRET` | yes | At least 32 characters. Signs the OAuth state cookie. |
| `CARDCRYPTO_API_BASE_URL` | yes | Backend base URL. `https`, or `http` for localhost or 127.0.0.1 only. |
| `CARDCRYPTO_API_KEY` | yes | `sk_test_...` or `sk_live_...`. |
| `CARDCRYPTO_WEBHOOK_SECRET` | yes | Signing secret of the endpoint that points at `/webhooks/cardcrypto`. |
| `CARDCRYPTO_TIMEOUT_MS` | no | Default 4000. |
| `WEBHOOK_CLAIM_TTL_SECONDS` | no | Default 300. A crashed worker's claim becomes reclaimable after this. |

`.env.example` lists them. Never commit `.env`.

## Running

```sh
npm install
npm run build
npm start          # node dist/src/server.js
```

## Endpoints

| Method and path | Behavior |
|---|---|
| `GET /healthz` | 200 when the database answers, otherwise 503. |
| `GET /auth?shop=` | Validates the shop, sets a signed HttpOnly state cookie (10 min), redirects to Shopify consent. |
| `GET /auth/callback` | Verifies the query HMAC and the state cookie, exchanges the code, stores the encrypted token. |
| `POST /webhooks/shopify/orders-create` | Verifies `X-Shopify-Hmac-Sha256` on the raw body first. Dedupes by `X-Shopify-Webhook-Id`. Creates the payment. Unknown topics get 404. |
| `POST /webhooks/cardcrypto` | Verifies `CardCrypto-Signature` (300 s window). Dedupes by body `id`. Handles `payment.captured`. |
| `GET /pay/:orderId?shop=<shop>` | 302 to the stored checkout URL. Shows "already paid" once the order is marked paid. |
| `GET /return` | Static "thank you" page. |

Webhook responses: 200 processed, duplicate, or rejected permanently (bad data, amount mismatch, Shopify
userErrors). 409 means another attempt is in flight. 500 means a transient failure, so the sender retries.
401 means a bad signature. 413 means the body exceeds 1 MB.

## Checkout (read this before going live)

- Shopify's native checkout accepts payment methods only through its payment ecosystem. Offsite
  payment apps require Shopify Partner approval and a payment-app contract. **That integration is
  not implemented here and is out of scope for this MVP.**
- What the MVP does: after the order exists, the merchant sends the customer
  `${APP_URL}/pay/<shopify order id>?shop=<store>.myshopify.com` (for example in the order
  notification or on the order status page). The customer pays on the Card-to-Crypto checkout, the
  backend sends `payment.captured`, and the order is marked paid in Shopify.
- The order must be created unpaid, through a payment method that leaves it pending. Which Shopify
  setting does this, and whether it works for this flow, is not verified here.

## What works

Verified in this sandbox:

- `npx tsc --noEmit`: passes (TypeScript 7.0.2, strict mode).
- `npm test`: 104 tests pass with `TEST_DATABASE_URL` set. Six of them are PostgreSQL tests run against
  `cardcrypto_shopify`. Without that variable the same run is 98 passing and the 6 PostgreSQL tests skip.
- Test coverage: OAuth HMAC (vector computed independently with OpenSSL), Shopify webhook HMAC (base64),
  CardCrypto signature (vector from OpenSSL, replay window at 300 s boundaries, rotated `v1` values),
  token encryption (round trip, tamper detection per segment, shop binding, wrong key), webhook dedupe
  and claim/release/stale-claim semantics (against PostgreSQL), orderMarkAsPaid body builder and request
  shape (injected fetch), CardCrypto client request shape, order-to-payment mapping, config validation,
  and end-to-end flows through the real router (install, order to payment, `/pay` redirect, capture to
  `orderMarkAsPaid`, replay, amount mismatch, retry after outages).
- Live run against the local database and a stub backend (not the real backend): `/healthz` 200;
  correctly signed `orders/create` 200 and payment created with `Idempotency-Key: shopify-order-<id>`;
  wrong-secret and tampered-body webhooks 401; duplicate delivery acknowledged; unknown topic 404;
  `/pay` 302 to the checkout URL; CardCrypto correctly signed events accepted, wrong secret 401, stale
  timestamp 401; no secrets or access tokens found in the logs; clean SIGTERM shutdown.

## Not verified and not done

- **No real Shopify store was used.** shopify.dev and the store domains were not reachable from this
  sandbox, so the OAuth consent, the real callback, real webhook delivery, and `orderMarkAsPaid` against
  a store are untested.
- **API version `2026-10`:** this is the newest version in `@shopify/shopify-api` 15.1.2, checked on npm.
  Stable status and support window were not checked on shopify.dev.
- **`orderMarkAsPaid`:** the operation name and `OrderMarkAsPaidInput! { id: ID! }` were confirmed in a
  public GitHub copy of the Admin schema (version unknown) and in public client code. The payload
  selection (`order { id }`, `userErrors`) follows the usual pattern and was not confirmed in a schema.
- **OAuth HMAC rule:** copied from `@shopify/shopify-api` 15.1.2 (sorted parameters, form-encoded values,
  `hmac` and `signature` excluded, 90 s timestamp window). Not checked against a live callback.
- **Not implemented:** `settlement.confirmed` order note (the field was not verified, so it is logged
  only). Refunds are not mirrored. `orders/create` registration is not automated. `app/uninstalled` and
  the mandatory GDPR webhooks are not handled. The admin UI is not embedded.
- The Card-to-Crypto webhook path that calls Shopify (`payment.captured` to `orderMarkAsPaid`) is covered by
  the flow tests with a stub, not by a live call.

## Shopify items a human must confirm

1. API version: `2026-10` is the default; confirm it is the current stable version and is supported.
2. Scopes: `read_orders,write_orders` are enough. Confirm the `orders/create` topic needs no further approval.
3. Protected customer data: order webhooks include customer fields. Request the required access in the
   Partner dashboard, or the email and name fields may be missing.
4. Currency: amounts use `total_price` and `currency`. For multi-currency stores, confirm whether this
   should be the presentment amount (`total_price_set.presentment_money`).
5. Token type: the app requests non-expiring offline tokens (`expiring: '0'`, the SDK default). Confirm
   Shopify still issues them to new apps. If expiring tokens are required, refresh-token handling is needed.
6. Payment app approval: an offsite payment integration at checkout needs Shopify approval and a contract.
   Without it, the checkout remains the `/pay` link described above.
7. Webhook behavior: confirm the response-time limit (this code can take up to 4 s on `orders/create`) and
   the retry policy for non-2xx responses.

## Production checklist

- Run behind HTTPS. Use a dedicated secret manager for `SHOPIFY_API_SECRET`, `TOKEN_ENCRYPTION_KEY`,
  `COOKIE_SECRET`, `CARDCRYPTO_WEBHOOK_SECRET`, and `CARDCRYPTO_API_KEY`. Rotate `TOKEN_ENCRYPTION_KEY` only
  with a re-encryption step, because tokens are unreadable with the wrong key.
- Register `orders/create` and make sure a CardCrypto webhook endpoint points at `/webhooks/cardcrypto`.
- Implement `app/uninstalled` (delete the shop's token) and the three mandatory GDPR webhooks
  (`customers/data_request`, `customers/redact`, `shop/redact`) before any App Store listing.
- Add an operator alert on log lines `shopify webhook rejected permanently`, `cardcrypto event rejected
  permanently`, and `shopify webhook failed; Shopify will retry`. Permanent rejections are acknowledged
  with 200, so they are not retried.
- Add a replay path for orders that were never linked (Shopify webhook deliveries can be resent from the admin).
- Use an authenticated, embedded admin UI if the app is to be listed.
- Decide what to do with currencies the backend does not accept (EUR, USD, GBP, CHF, CAD, AUD, RSD).
- Add request logging with redaction, metrics, and a database backup policy.
- Consider a queue for `orders/create` so Shopify always gets a fast 200.
