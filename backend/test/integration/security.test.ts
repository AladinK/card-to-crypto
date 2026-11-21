import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, hashPassword, totpCode } from '../../src/core/security.js';
import { createHarness, startReceiver, type Receiver, type TestHarness } from '../helpers.js';
import { attemptDelivery, WEBHOOK_MAX_ATTEMPTS } from '../../src/webhooks/outbound.js';
import { verifyAuditChain } from '../../src/audit/audit.js';

/** Security, reliability and authorization behaviour that must never regress. */
describe('security and reliability', () => {
  let h: TestHarness;
  let receiver: Receiver;
  let ownerId: string;
  let merchantId: string;
  let ownerToken: string;
  let refreshToken: string;
  let api: Record<string, string>;
  let apiKeyId: string;

  const deliveryDeps = () => ({ db: h.db, encryptionKey: h.config.dataEncryptionKey, allowPrivateTargets: true, timeoutMs: 3000 });

  beforeAll(async () => {
    h = await createHarness();
    receiver = await startReceiver();
    const reg = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { merchant_name: 'Sec Test d.o.o.', email: 'sec@shop.test', password: 'a very long passphrase' },
    });
    ownerId = reg.json().user_id;
    merchantId = reg.json().merchant_id;
    ownerToken = reg.json().access_token;
    refreshToken = reg.json().refresh_token;
    const key = await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${ownerToken}` }, payload: { name: 'server', mode: 'test' } });
    apiKeyId = key.json().id;
    api = { authorization: `Bearer ${key.json().secret}` };
  });

  afterAll(async () => {
    await receiver?.close();
    await h?.close();
  });

  /** Creates a verified settlement wallet once; returns nothing. */
  async function ensureVerifiedWallet(): Promise<void> {
    const count = await h.db.query("SELECT count(*)::int AS n FROM wallets WHERE merchant_id = $1 AND status = 'VERIFIED'", [merchantId]);
    if (count.rows[0].n > 0) return;
    const account = privateKeyToAccount(generatePrivateKey());
    const add = await h.app.inject({ method: 'POST', url: '/v1/wallet', headers: api, payload: { blockchain: 'base', asset: 'USDC', address: account.address } });
    const signature = await account.signMessage({ message: add.json().verification.message });
    await h.app.inject({ method: 'POST', url: `/v1/wallet/${add.json().id}/verify`, headers: api, payload: { signature } });
    await h.app.inject({ method: 'POST', url: `/v1/wallet/${add.json().id}/default`, headers: api });
  }

  async function createPendingPayment(orderId: string): Promise<string> {
    await ensureVerifiedWallet();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...api, 'idempotency-key': `pp-${randomUUID()}` },
      payload: { amount: '40.00', currency: 'EUR', order_id: orderId, return_url: 'https://shop.test/x' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('rejects requests without credentials, with garbage tokens, and with unknown keys', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/payments' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/payments', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    const forged = `sk_test_${'a'.repeat(16)}_${'b'.repeat(43)}`;
    expect((await h.app.inject({ method: 'GET', url: '/v1/payments', headers: { authorization: `Bearer ${forged}` } })).statusCode).toBe(401);
  });

  it('enforces two-factor authentication at login and blocks code replay', async () => {
    const setup = await h.app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: { authorization: `Bearer ${ownerToken}` } });
    expect(setup.statusCode).toBe(200);
    const secret: string = setup.json().secret;
    const code = totpCode(secret, Math.floor(Date.now() / 30_000));
    const enable = await h.app.inject({ method: 'POST', url: '/v1/auth/mfa/enable', headers: { authorization: `Bearer ${ownerToken}` }, payload: { code } });
    expect(enable.statusCode).toBe(204);

    const noCode = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'sec@shop.test', password: 'a very long passphrase' } });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error.code).toBe('totp_required');

    const wrongPassword = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'sec@shop.test', password: 'wrong wrong wrong' } });
    expect(wrongPassword.statusCode).toBe(401);

    // Use the next step so the enrolment code (same step) cannot be replayed at login.
    const nextCode = totpCode(secret, Math.floor(Date.now() / 30_000) + 1);
    const login = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'sec@shop.test', password: 'a very long passphrase', totp_code: nextCode } });
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa).toBe(true);
    const replay = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'sec@shop.test', password: 'a very long passphrase', totp_code: nextCode } });
    expect(replay.statusCode).toBe(401);

    const stored = (await h.db.query('SELECT totp_secret_enc FROM users WHERE id = $1', [ownerId])).rows[0];
    expect(stored.totp_secret_enc).not.toContain(secret); // encrypted at rest
    expect(decryptSecret(stored.totp_secret_enc, h.config.dataEncryptionKey)).toBe(secret);
  });

  it('rotates refresh tokens and revokes the whole family when an old one is reused', async () => {
    const first = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: refreshToken } });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: first.json().refresh_token } });
    expect(second.statusCode).toBe(200);

    // Presenting the already-rotated token signals theft: the newest token in the family dies too.
    const reuse = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: refreshToken } });
    expect(reuse.statusCode).toBe(401);
    const afterTheft = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: second.json().refresh_token } });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('isolates merchants: another merchant cannot read these payments', async () => {
    const reg = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { merchant_name: 'Other Shop', email: 'other@shop.test', password: 'another long passphrase' },
    });
    const key = await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${reg.json().access_token}` }, payload: { name: 'o', mode: 'test' } });
    const otherApi = { authorization: `Bearer ${key.json().secret}` };
    const paymentId = await createPendingPayment('ISO-1');
    const foreign = await h.app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: otherApi });
    expect(foreign.statusCode).toBe(404);
  });

  it('refuses to attach a sanctioned address as settlement destination', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/wallet',
      headers: api,
      payload: { blockchain: 'polygon', asset: 'USDC', address: '0x000000000000000000000000000000000000dEaD' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('address_not_allowed');
  });

  it('keeps viewers read-only', async () => {
    const hash = await hashPassword('viewer passphrase here');
    await h.db.query("INSERT INTO users (id, merchant_id, email, password_hash, role) VALUES ('usr_viewer', $1, 'viewer@shop.test', $2, 'viewer')", [merchantId, hash]);
    const login = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'viewer@shop.test', password: 'viewer passphrase here' } });
    const viewer = { authorization: `Bearer ${login.json().access_token}` };
    expect((await h.app.inject({ method: 'GET', url: '/v1/payments', headers: viewer })).statusCode).toBe(200);
    const write = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...viewer, 'idempotency-key': `viewer-${randomUUID()}` },
      payload: { amount: '1.00', currency: 'EUR', order_id: 'V-1', return_url: 'https://shop.test/x' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('requires two-factor authentication before live API keys are issued', async () => {
    await h.db.query("UPDATE merchants SET live_enabled = TRUE, kyb_status = 'APPROVED' WHERE id = $1", [merchantId]);
    // The session from the TOTP login above has mfa = true; a password-only session would not.
    const passwordOnly = await h.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { merchant_name: 'Live Check', email: 'live@shop.test', password: 'live check passphrase' } });
    const liveMerchant = passwordOnly.json().merchant_id;
    await h.db.query("UPDATE merchants SET live_enabled = TRUE, kyb_status = 'APPROVED' WHERE id = $1", [liveMerchant]);
    const noMfa = await h.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${passwordOnly.json().access_token}`, 'x-mode': 'live' },
      payload: { name: 'prod', mode: 'live' },
    });
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json().error.code).toBe('mfa_required');
    await h.db.query("UPDATE merchants SET live_enabled = FALSE, kyb_status = 'PENDING' WHERE id = $1", [merchantId]);
  });

  it('rotates and revokes API keys', async () => {
    const rotated = await h.app.inject({ method: 'POST', url: `/v1/api-keys/${apiKeyId}/rotate`, headers: api, payload: { grace_hours: 0 } });
    expect(rotated.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/v1/payments', headers: api })).statusCode).toBe(401); // old key ended immediately
    const fresh = { authorization: `Bearer ${rotated.json().secret}` };
    expect((await h.app.inject({ method: 'GET', url: '/v1/payments', headers: fresh })).statusCode).toBe(200);
    await h.app.inject({ method: 'POST', url: `/v1/api-keys/${rotated.json().id}/revoke`, headers: fresh });
    expect((await h.app.inject({ method: 'GET', url: '/v1/payments', headers: fresh })).statusCode).toBe(401);
    // Later tests need a working key: issue one from the dashboard session.
    const replacement = await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${ownerToken}` }, payload: { name: 'after-rotation', mode: 'test' } });
    api = { authorization: `Bearer ${replacement.json().secret}` };
  });

  it('holds payments whose authorized amount does not match the order', async () => {
    const paymentId = await createPendingPayment('AMT-1');
    const tampered = await h.container.payments.ingest('sandbox', [
      {
        kind: 'payment.authorized',
        eventId: `evt-${randomUUID()}`,
        paymentId,
        providerSessionId: null,
        providerPaymentId: `sandbox_pi_${paymentId}`,
        amountMinor: 1n,
        currency: 'EUR',
        paymentMethod: null,
        cardCountry: null,
        reason: null,
      },
    ]);
    expect(tampered.applied).toBe(0);
    const { rows } = await h.db.query('SELECT status, hold_reason FROM payments WHERE id = $1', [paymentId]);
    expect(rows[0]).toMatchObject({ status: 'PAYMENT_PENDING', hold_reason: 'AMOUNT_MISMATCH' });
  });

  it('ignores provider events that reference a different provider payment', async () => {
    const paymentId = await createPendingPayment('REF-1');
    const foreign = await h.container.payments.ingest('sandbox', [
      {
        kind: 'payment.captured',
        eventId: `evt-${randomUUID()}`,
        paymentId,
        providerSessionId: null,
        providerPaymentId: 'sandbox_pi_someone_else',
        amountMinor: 4000n,
        currency: 'EUR',
        paymentMethod: null,
        cardCountry: null,
        reason: null,
      },
    ]);
    expect(foreign.applied).toBe(0);
    const { rows } = await h.db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    expect(rows[0].status).toBe('PAYMENT_PENDING');
  });

  it('applies each provider event once even when the provider redelivers it', async () => {
    const paymentId = await createPendingPayment('DUP-1');
    const event = {
      kind: 'payment.authorized' as const,
      eventId: `evt-dup-${randomUUID()}`,
      paymentId,
      providerSessionId: null,
      providerPaymentId: `sandbox_pi_${paymentId}`,
      amountMinor: 4000n,
      currency: 'EUR' as const,
      paymentMethod: 'card',
      cardCountry: 'RS',
      reason: null,
    };
    const first = await h.container.payments.ingest('sandbox', [event]);
    const second = await h.container.payments.ingest('sandbox', [event]);
    expect(first.applied).toBe(1);
    expect(second.duplicates).toBe(1);
    const transitions = await h.db.query("SELECT count(*)::int AS n FROM payment_transitions WHERE payment_id = $1 AND to_status = 'PAYMENT_AUTHORIZED'", [paymentId]);
    expect(transitions.rows[0].n).toBe(1);
  });

  it('retries failed webhook deliveries and dead-letters them after the last attempt', async () => {
    const endpoint = await h.app.inject({ method: 'POST', url: '/v1/webhook-endpoints', headers: api, payload: { url: receiver.url, events: ['payment.created'] } });
    expect(endpoint.statusCode).toBe(201);
    const paymentId = await createPendingPayment('HOOK-RETRY');

    const deliveries = await h.db.query(
      `SELECT d.id FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
       WHERE e.payment_id = $1 AND d.endpoint_id = $2 ORDER BY d.created_at LIMIT 1`,
      [paymentId, endpoint.json().id],
    );
    const deliveryId = deliveries.rows[0]?.id as string;
    expect(deliveryId).toBeTruthy();

    receiver.failNext(1, 500);
    expect(await attemptDelivery(deliveryDeps(), deliveryId)).toBe('retrying');
    expect(await attemptDelivery(deliveryDeps(), deliveryId)).toBe('delivered');

    // A permanently failing endpoint, on its final attempt, goes to the dead-letter state.
    await h.db.query("UPDATE webhook_deliveries SET status = 'PENDING', attempts = $2 WHERE id = $1", [deliveryId, WEBHOOK_MAX_ATTEMPTS - 1]);
    receiver.failNext(5, 503);
    expect(await attemptDelivery(deliveryDeps(), deliveryId)).toBe('dead');
    const state = await h.db.query('SELECT status, last_status_code FROM webhook_deliveries WHERE id = $1', [deliveryId]);
    expect(state.rows[0]).toMatchObject({ status: 'DEAD', last_status_code: 503 });
  });

  it('keeps an audit trail that cannot be edited and whose hash chain verifies', async () => {
    const chain = await verifyAuditChain(h.db);
    expect(chain.ok).toBe(true);
    expect(chain.rows).toBeGreaterThan(0);
    await expect(h.db.query("UPDATE audit_logs SET action = 'tampered' WHERE id = (SELECT min(id) FROM audit_logs)")).rejects.toThrow(/append-only/);
    await expect(h.db.query('DELETE FROM payment_transitions')).rejects.toThrow(/append-only/);
  });

  it('exposes platform operations only to platform administrators', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/jobs', headers: api })).statusCode).toBe(403);

    const hash = await hashPassword('platform admin passphrase');
    await h.db.query(
      "INSERT INTO users (id, merchant_id, email, password_hash, role, is_platform_admin) VALUES ('usr_admin', NULL, 'ops@cardcrypto.test', $1, 'owner', TRUE)",
      [hash],
    );
    const login = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'ops@cardcrypto.test', password: 'platform admin passphrase' } });
    const admin = { authorization: `Bearer ${login.json().access_token}` };
    const health = await h.app.inject({ method: 'GET', url: '/v1/admin/health', headers: admin });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toHaveProperty('jobs');
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/audit-logs/verify', headers: admin })).json().ok).toBe(true);
  });

  it('expires abandoned checkouts and returns the order to unpaid', async () => {
    const paymentId = await createPendingPayment('EXPIRE-1');
    await h.db.query("UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = $1", [paymentId]);
    expect(await h.container.payments.expireStale()).toBeGreaterThanOrEqual(1);
    const p = (await h.app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: api })).json();
    expect(p.status).toBe('CANCELLED');
    expect(p.failure_reason).toBe('checkout_expired');
    const order = await h.db.query("SELECT status FROM orders WHERE external_order_id = 'EXPIRE-1'");
    expect(order.rows[0].status).toBe('UNPAID');
  });

  it('blocks all payments from a frozen merchant', async () => {
    const login = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'ops@cardcrypto.test', password: 'platform admin passphrase' } });
    const adminAuth = { authorization: `Bearer ${login.json().access_token}` };
    const freeze = await h.app.inject({ method: 'POST', url: `/v1/admin/merchants/${merchantId}/status`, headers: adminAuth, payload: { status: 'FROZEN' } });
    expect(freeze.statusCode).toBe(204);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...api, 'idempotency-key': `frozen-${randomUUID()}` },
      payload: { amount: '5.00', currency: 'EUR', order_id: 'FROZEN-1', return_url: 'https://shop.test/x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('merchant_frozen');
  });
});
