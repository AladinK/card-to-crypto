# CardCrypto merchant dashboard

A Next.js 16 (App Router) dashboard for merchants of the card-to-crypto payments backend. Merchants sign in,
watch payments and settlements, manage settlement wallets, create API keys and webhook endpoints, inspect
deliveries, and refund payments.

The app talks to the API only through its own server (a backend-for-frontend). The browser never receives an
access token and never calls the API directly.

## Requirements

- Node.js 20.9 or newer (developed and tested on Node 22)
- A running card-to-crypto API (`backend/`) and its job worker (`backend/dist/worker.js`). Settlements only
  progress while the worker runs.

## Install

```bash
cd dashboard
npm install
cp .env.example .env.local   # optional, see Configuration
```

## Run

```bash
npm run dev          # development server on http://localhost:3001
npm run build        # production build
npm start            # serves the production build on http://localhost:3001
npm run typecheck    # tsc --noEmit
```

## Configuration

| Variable       | Default                 | Notes                                                                                   |
| -------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `API_BASE_URL` | `http://localhost:3000` | Base URL of the card-to-crypto API. Read on the Next.js server only; never sent to the browser. |
| `NODE_ENV`     | set by Next.js          | `production` turns on `Secure` cookies and HSTS.                                        |

The dashboard has no other secrets. It holds no API keys of its own. Sessions are the merchant's refresh tokens
in httpOnly cookies.

## Pages

| Route                 | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `/login`              | Email and password, then a 6-digit code step when two-factor authentication is on.            |
| `/register`           | Creates the merchant and its owner account.                                                   |
| `/`                   | Overview: KPI cards from `GET /v1/analytics/summary`, with a period selector (7, 30, 90 days, or custom). |
| `/transactions`       | `GET /v1/transactions` table; row or order link opens the payment.                            |
| `/payments/[id]`      | Payment, settlement (fee breakdown, confirmations, hold and error details) and the refund form. |
| `/wallets`            | Add a wallet, show the verification message exactly as returned, verify with a signature, set default, disable. |
| `/developers`         | API keys (create, rotate, revoke), webhook endpoints (create, rotate secret, disable), deliveries (filter, detail, replay). |
| `/settings`           | Account and merchant status from `GET /v1/me`, and two-factor setup.                          |

Test and live mode are switched in the top bar. Live stays disabled until the API reports
`live_enabled` for the merchant.

## Architecture: backend for frontend

```
browser  ──(same origin, cookies)──▶  Next.js route handlers (app/api/*)  ──(Bearer access token)──▶  card-to-crypto API
  no tokens in JS                       holds refresh token (cookie)                                   /v1/*
  no localStorage / sessionStorage       holds access tokens (memory)
```

**Cookies** (all `httpOnly`, `SameSite=Lax`, `Secure` in production, `path=/`):

- `cc_rt`: the refresh token, 14 days (matches the API's default). The only credential the browser holds.
- `cc_mode`: `test` or `live`. Validated on every request. Live is refused unless the merchant has it enabled.
- `cc_theme`: light, dark, or absent for the system setting. Not a credential; read by the server so the first
  paint uses the right theme.

**Access tokens** stay in server memory (`lib/bff/session-store.ts`), keyed by the SHA-256 of the refresh token.

- The API rotates refresh tokens on every use and revokes the whole family on reuse. Refreshes are therefore
  single-flighted per token, and a stale cookie is followed to its successor for 120 seconds. Without this,
  two parallel requests would burn the same refresh token and log the merchant out.
- If the API rejects an access token ("Invalid or expired access token."), the BFF refreshes once and retries.
  Other 401s, such as a wrong TOTP code, are passed through unchanged.
- If the refresh fails, the BFF returns `401 session_expired`, clears `cc_rt`, and the client sends the user to
  `/login`.

**Gateway** (`lib/bff/gateway.ts`, `app/api/v1/[...path]/route.ts`):

- Only endpoints in the allowlist (`lib/bff/routes.ts`) are forwarded. Everything else, including operator and
  provider-webhook routes, returns 404.
- Only `from`, `to`, `limit`, `status` and `starting_after` query parameters are forwarded. Bodies are capped at
  16 KB and must be valid JSON. `Idempotency-Key` is forwarded when it is 8 to 255 printable characters.
- API errors pass through as `{ "error": { type, code, message, request_id, details } }`. Stack traces are never
  returned. Unexpected failures return a generic message and log only the error name.

**Forgery protection:** every state-changing BFF route requires the header `X-Dashboard-Request: 1`, which forces
a CORS preflight that the app never grants. The `Origin` and `Sec-Fetch-Site` headers must also be same-origin.

**Headers:**

- `next.config.ts`: `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Content-Type-Options: nosniff`, a `Permissions-Policy` that disables camera, microphone, geolocation,
  payment and USB, `Cross-Origin-Opener-Policy: same-origin`, HSTS in production, and a locked-down CSP
  (`default-src 'none'`) on `/api/*`.
- `proxy.ts` (Next.js 16 proxy): on every page request, a fresh nonce and the CSP
  `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'`
  (plus `img-src 'self' data:`, `object-src 'none'`, `frame-ancestors 'none'`). No third-party origins are
  allowed. `'unsafe-eval'` is added in development only. `'unsafe-inline'` for styles is needed because React
  sets `style` attributes, which nonces cannot cover.

**Money:** amounts are displayed exactly as the API returns them, as decimal strings. Grouping separators are
added as text. Fee values that the API returns as minor-unit integers are converted by moving the decimal point
in the string. No amount is ever parsed to a JavaScript number.

**Idempotency:** each refund submit sends a new `Idempotency-Key` (`crypto.randomUUID()`, with a random-bytes
fallback on plain HTTP). The submit button is disabled while the request runs, so a double click cannot send
two keys.

**One-time secrets:** API keys and webhook signing secrets are shown only in the dialog that created or rotated
them, held in component state, and removed from the DOM when the dialog closes.

## Known limitations

1. **Single process.** Access tokens live in process memory. Behind several Next.js instances, use sticky
   sessions or move the token cache to a shared store, or parallel refreshes can trigger refresh-token reuse
   detection.
2. **Per-IP rate limits in the API.** Login, register, refresh and logout are limited per client IP. All merchants
   behind one dashboard server share its IP, so the refresh limit (10 per minute) will be hit at scale. Forward the
   real client IP (`TRUST_PROXY=true` with a trusted proxy), or key these limits by session.
3. **Transactions have no cursor and no date filter.** The table shows the latest 25, 50 or 100 rows. Order-ID and
   status filtering happen in the browser.
4. **Wallet verification message is shown once.** The API does not return it again. After a page reload, an
   unverified wallet cannot be verified from the dashboard, and adding it again returns `wallet_exists`.
5. **Settlement fee values are minor units.** `GET /v1/payments/{id}/settlement` returns `fees` as integer strings
   in cents, not decimal strings. The dashboard converts them for display. `asset` can be null on the settlement
   row, so the dashboard falls back to the payment's settlement asset.
6. **Payment `order_id` is internal.** `GET /v1/payments/{id}` returns the internal `ord_…` id. The merchant's own
   `order_id` appears only in `/v1/transactions`.
7. **Analytics fees are summed across currencies** (see `fees.currency_note` in the response).
8. **Live mode** has UI logic and server checks, but could not be exercised end to end in this environment (no
   live-enabled merchant or Stripe/RPC configuration). The live-enabled state was only observed as disabled.
9. No internationalisation (English only). No charts: the API has no time-series endpoint.
10. Next.js `proxy.ts` makes every page dynamic (required for nonces). Page caching is not used.
11. The same-origin check compares `Origin` with the request's own origin. Behind a reverse proxy, make sure the
    proxy forwards the public `Host` header, or every write will return `csrf_check_failed`.
