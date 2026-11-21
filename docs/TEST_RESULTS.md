# Test results (authoring environment)

Environment: Linux, Node.js 22.23.5, PostgreSQL 16.15 (local), no outbound internet except the npm registry.

| Suite | Command | Result |
|---|---|---|
| Backend unit + integration | `TEST_DATABASE_URL=… npm test -w @cardcrypto/backend` | **68 / 68 passed** in 6 files, about 7 s |
| Backend typecheck | `npx tsc -p backend/tsconfig.json --noEmit` | **0 errors** |
| SDK | `npm test -w @cardcrypto/sdk` (build + node:test) | **4 / 4 passed**, 0 type errors |
| Production build | `npm run build -w @cardcrypto/backend` | succeeds; API and worker start from `dist/` |
| Live process smoke | API and worker processes, sandbox demo over HTTP (`npm run demo`) | full flow succeeded (see below) |

## What the tests cover

**Unit** (`test/unit/`)
- Money parsing and formatting without floats; malformed and over-precise amounts rejected.
- Fee engine: percentage, fixed and network fees; amounts that do not cover fees rejected; network fees rounded up.
- Conversion: crypto amounts rounded down in base units (`108.695652 USDC` for €100 at 0.92).
- State machine: legal transitions and rejected skips (for example SETTLED → CONVERSION_PENDING).
- Security primitives: RFC 6238 TOTP vector, replay protection of TOTP steps, AES-256-GCM round trip and tamper detection, scrypt password hashing, webhook HMAC with tolerance window, API key format.
- Risk engine: scoring, escalation, disposable email, bad IP reputation.
- Network safety: loopback, private, link-local and CGNAT addresses classified as private.
- Rates: sandbox derivation, live-source parsing, caching, rejection of unusable answers.
- Chain registry: every stablecoin contract address is checksum-valid.
- Wallet ownership: real EIP-191 signature accepted, other wallet and tampered message rejected.
- Stripe adapter: signature verification with the SDK test helper; manual-capture authorization, refund and irrelevant events mapped; forged signatures rejected.
- Sandbox provider: checkout token bound to payment id; simulator events require the sandbox HMAC.
- Sandbox chain: pending → included → confirmed timing; transfer event verified by amount.

**Integration, sandbox end to end** (`test/integration/sandbox-flow.test.ts`, HTTP via `app.inject`)
- Registration, test API key (stored hashed), live mode refused without approval.
- Wallet registration, verification by a real signature, default selection; wrong signature refused.
- Webhook endpoint with the secret shown once; the receiver verifies `CardCrypto-Signature` as a merchant would.
- Payment creation, hosted sandbox checkout (test cards, forged token refused, CSP header), card authorization, capture, USDC settlement with 3 confirmations.
- Ledger row with fees, network fee, wallet, transaction hash.
- Signed lifecycle webhooks: payment.created, payment.captured, conversion.completed, settlement.confirmed.
- Partial refund, over-refund refused, remainder refund, PARTIALLY_REFUNDED → REFUNDED, crypto recovery OPEN.
- Idempotency: replay returns the original response; reused key with different body → 422; missing key → 400.
- Duplicate paid order refused (409); declined card leaves the order unpaid and allows a new attempt.
- Analytics summary.

**Integration, security and reliability** (`test/integration/security.test.ts`)
- Unauthenticated, malformed and forged credentials refused.
- TOTP enforced at login; same code cannot be replayed.
- Refresh token rotation; reuse of a rotated token revokes the family.
- Merchant isolation (404 across merchants).
- Sanctioned address refused as settlement destination.
- Viewer role is read-only.
- Live API keys require approval and two-factor sign-in.
- API key rotation with immediate expiry; revocation.
- Provider event with a tampered amount is held (AMOUNT_MISMATCH) and not applied.
- Provider event referencing another payment is ignored.
- Duplicate provider event applied exactly once.
- Webhook retry, then dead-letter after the final attempt.
- Audit trail: hash chain verifies; UPDATE and DELETE on append-only tables rejected by the database.
- Platform admin endpoints reject merchants; admin health and audit verification work.
- Abandoned checkout expires to CANCELLED; order returns to UNPAID.
- Frozen merchant blocked from creating payments.

**Integration, EVM on an in-process chain** (`test/integration/evm.test.ts`)
- An ERC-20 token is compiled with solc and deployed to ganache (chain id 137).
- The live EVM adapter signs an EIP-1559 `transfer`; the signer address is recovered from the digest.
- Broadcast, receipt, Transfer log verification (exact recipient and amount), balances and nonce accounting.
- Rebroadcast of an already mined transaction is treated as submitted (crash-recovery path).
- Unknown transaction hashes are reported as `not_found`, never as success.

**Integration, system** (`test/integration/system.test.ts`): health and readiness, OpenAPI served, JSON error envelope, strict schemas, `javascript:` return URLs refused.

## Live process smoke (API and worker as separate processes)

```
1. merchant registered             ok
2. test API key issued             ok
3. wallet verified by signature    VERIFIED
4. payment created                 PAYMENT_PENDING (€100.00)
5. shopper paid (test card 4242…)  HTTP 303
6. settled on-chain                SETTLED
7. settlement                      merchant_received 105.695652 USDC, rate 0.92, network fee €0.01, 3 confirmations
8. partial refund 25.00 EUR        SUCCEEDED, crypto_recovery OPEN
9. payment after refund            PARTIALLY_REFUNDED, refunded 25.00
10. ledger                         1 row
```

Arithmetic check for step 7: €100.00 − €1.75 (payment, 1.5% + €0.25) − €0.50 (conversion, 0.5%) − €0.50 (platform, 0.5%) − €0.01 (network) = €97.24; €97.24 / 0.92 = 105.695652 USDC.

Worker and API logs during the run contained no error-level entries and no 5xx responses.

## Not verified here

- Docker image build and compose stack (no Docker daemon in the authoring environment).
- Stripe live API calls, CoinGecko live rates, Polygon/Base/Arbitrum RPC (no outbound internet). The Stripe adapter is tested for signature verification and event mapping; the EVM adapter is tested on an in-process chain.
- Treasury KMS signer (not implemented; see `docs/DEPLOYMENT.md`).
- Load and soak testing; penetration testing.
