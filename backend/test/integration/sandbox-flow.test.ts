import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, expectedSignature, startReceiver, type Receiver, type TestHarness } from '../helpers.js';

/**
 * End-to-end sandbox flow through the real HTTP layer:
 * register -> API key -> wallet proof -> card payment -> settlement -> webhooks -> refunds.
 */
describe('sandbox end-to-end flow', () => {
  let h: TestHarness;
  let receiver: Receiver;
  let dashboard: Record<string, string>;
  let api: Record<string, string>;
  let secret: string;
  let paymentId: string;
  let checkoutToken: string;
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    h = await createHarness();
    receiver = await startReceiver();
  });

  afterAll(async () => {
    await receiver?.close();
    await h?.close();
  });

  it('registers a merchant and issues a test API key', async () => {
    const reg = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { merchant_name: 'Shop d.o.o.', email: 'owner@shop.test', password: 'correct horse battery staple', country: 'RS' },
    });
    expect(reg.statusCode).toBe(201);
    dashboard = { authorization: `Bearer ${reg.json().access_token}` };

    const key = await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: dashboard, payload: { name: 'server', mode: 'test' } });
    expect(key.statusCode).toBe(201);
    expect(key.json().secret).toMatch(/^sk_test_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
    api = { authorization: `Bearer ${key.json().secret}` };

    // Keys are stored hashed: the secret never appears in the database.
    const stored = await h.db.query('SELECT secret_hash FROM api_keys');
    expect(JSON.stringify(stored.rows)).not.toContain(key.json().secret.split('_').pop());
  });

  it('refuses live mode for an account that is not approved', async () => {
    const key = await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: dashboard, payload: { name: 'prod', mode: 'live' } });
    expect(key.statusCode).toBe(403);
    expect(key.json().error.code).toBe('live_mode_not_enabled');
  });

  it('verifies settlement wallet ownership with a real EVM signature', async () => {
    const add = await h.app.inject({
      method: 'POST',
      url: '/v1/wallet',
      headers: api,
      payload: { blockchain: 'polygon', asset: 'USDC', address: account.address.toLowerCase() },
    });
    expect(add.statusCode).toBe(201);
    const wallet = add.json();
    expect(wallet.address).toBe(account.address); // checksummed
    expect(wallet.verification.message).toContain('CardCrypto wallet verification');

    const badSig = await h.app.inject({
      method: 'POST',
      url: `/v1/wallet/${wallet.id}/verify`,
      headers: api,
      payload: { signature: `0x${'11'.repeat(65)}` },
    });
    expect(badSig.statusCode).toBe(422);

    const signature = await account.signMessage({ message: wallet.verification.message });
    const ok = await h.app.inject({ method: 'POST', url: `/v1/wallet/${wallet.id}/verify`, headers: api, payload: { signature } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('VERIFIED');

    const def = await h.app.inject({ method: 'POST', url: `/v1/wallet/${wallet.id}/default`, headers: api });
    expect(def.statusCode).toBe(200);
    expect(def.json().is_default).toBe(true);
  });

  it('registers a webhook endpoint and returns its signing secret once', async () => {
    const ep = await h.app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: api,
      payload: { url: receiver.url, events: ['*'] },
    });
    expect(ep.statusCode).toBe(201);
    secret = ep.json().secret;
    expect(secret).toMatch(/^whsec_/);

    const listed = await h.app.inject({ method: 'GET', url: '/v1/webhook-endpoints', headers: api });
    expect(JSON.stringify(listed.json())).not.toContain(secret);
  });

  it('creates a hosted checkout, takes the card payment and settles USDC on-chain', async () => {
    const idem = `pay-${randomUUID()}`;
    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...api, 'idempotency-key': idem },
      payload: {
        amount: '100.00',
        currency: 'EUR',
        order_id: 'ORDER-10482',
        customer: { email: 'buyer@example.com' },
        return_url: 'https://shop.test/thanks',
        description: 'Order 10482',
      },
    });
    expect(create.statusCode).toBe(201);
    const payment = create.json();
    paymentId = payment.id;
    expect(payment.status).toBe('PAYMENT_PENDING');
    expect(payment.amount).toBe('100.00');
    expect(payment.settlement.asset).toBe('USDC');

    const url = new URL(payment.checkout_url);
    checkoutToken = url.searchParams.get('t') ?? '';
    const page = await h.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('4242 4242 4242 4242');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");

    const wrongToken = await h.app.inject({ method: 'GET', url: `${url.pathname}?t=forged` });
    expect(wrongToken.statusCode).toBe(404);

    const pay = await h.app.inject({
      method: 'POST',
      url: `/checkout/sandbox/${paymentId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `t=${checkoutToken}&outcome=success`,
    });
    expect(pay.statusCode).toBe(303);

    await h.drain(async () => (await settledStatus()) === 'SETTLED');
    expect(await settledStatus()).toBe('SETTLED');

    const settlement = await h.app.inject({ method: 'GET', url: `/v1/payments/${paymentId}/settlement`, headers: api });
    const s = settlement.json();
    expect(s.status).toBe('SETTLED');
    expect(s.transaction_hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(s.exchange_rate).toBeTruthy();
    expect(Number(s.merchant_received)).toBeGreaterThan(100);
    expect(Number(s.merchant_received)).toBeLessThan(110);
    expect(s.wallet_address).toBe(account.address);
    expect(s.confirmations).toBeGreaterThanOrEqual(3);

    const payments = await h.app.inject({ method: 'GET', url: '/v1/payments', headers: api });
    expect(payments.json().data[0].id).toBe(paymentId);
  });

  it('records a ledger row with fees, network fee, wallet and transaction hash', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/transactions', headers: api });
    const row = res.json().data.find((r: { payment_id: string }) => r.payment_id === paymentId);
    expect(row).toBeDefined();
    expect(row.order_id).toBe('ORDER-10482');
    expect(row.customer_amount).toBe('100.00');
    expect(row.payment_status).toBe('SETTLED');
    expect(row.crypto_asset).toBe('USDC');
    expect(row.payment_fee).toMatch(/^\d+\.\d{2}$/);
    expect(row.network_fee).toMatch(/^\d+\.\d{2}$/);
    expect(row.transaction_hash).toMatch(/^0x/);
    expect(row.blockchain).toBe('polygon');
    // Fees are deducted, so the merchant receives less than the gross crypto equivalent.
    expect(Number(row.merchant_received)).toBeLessThan(Number(row.crypto_amount));
  });

  it('delivers signed webhooks for every lifecycle event', async () => {
    await h.drain(async () => receiver.requests.some((r) => JSON.parse(r.body).event === 'settlement.confirmed'));
    const types = receiver.requests.map((r) => JSON.parse(r.body).event);
    for (const expected of ['payment.created', 'payment.captured', 'conversion.completed', 'settlement.confirmed']) {
      expect(types).toContain(expected);
    }

    const confirmed = receiver.requests.find((r) => JSON.parse(r.body).event === 'settlement.confirmed');
    expect(confirmed).toBeDefined();
    const body = JSON.parse(confirmed!.body);
    expect(body).toMatchObject({ payment_id: paymentId, order_id: 'ORDER-10482', fiat_amount: '100.00', fiat_currency: 'EUR', crypto_asset: 'USDC', network: 'polygon', status: 'confirmed' });
    expect(body.tx_hash).toMatch(/^0x/);

    // The merchant-side verification the docs prescribe.
    const header = String(confirmed!.headers['cardcrypto-signature']);
    const timestamp = /t=(\d+)/.exec(header)?.[1] ?? '';
    const signature = /v1=([a-f0-9]{64})/.exec(header)?.[1] ?? '';
    expect(signature).toBe(expectedSignature(secret, timestamp, confirmed!.body));
  });

  it('processes a partial refund and then the remainder', async () => {
    const partial = await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${paymentId}/refund`,
      headers: { ...api, 'idempotency-key': `refund-${randomUUID()}` },
      payload: { amount: '30.00', reason: 'requested_by_customer' },
    });
    expect(partial.statusCode).toBe(201);
    expect(partial.json().status).toBe('SUCCEEDED');
    expect(partial.json().crypto_recovery.status).toBe('OPEN');

    let p = (await h.app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: api })).json();
    expect(p.status).toBe('PARTIALLY_REFUNDED');
    expect(p.refunded_amount).toBe('30.00');

    const tooMuch = await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${paymentId}/refund`,
      headers: { ...api, 'idempotency-key': `refund-${randomUUID()}` },
      payload: { amount: '80.00' },
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().error.code).toBe('refund_exceeds_refundable');

    const rest = await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${paymentId}/refund`,
      headers: { ...api, 'idempotency-key': `refund-${randomUUID()}` },
      payload: {},
    });
    expect(rest.statusCode).toBe(201);
    p = (await h.app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: api })).json();
    expect(p.status).toBe('REFUNDED');
    expect(p.refunded_amount).toBe('100.00');
  });

  it('replays identical retries and rejects reused keys with different bodies', async () => {
    const key = `idem-${randomUUID()}`;
    const body = { amount: '5.00', currency: 'EUR', order_id: 'ORDER-IDEM', return_url: 'https://shop.test/x' };
    const first = await h.app.inject({ method: 'POST', url: '/v1/payments', headers: { ...api, 'idempotency-key': key }, payload: body });
    expect(first.statusCode).toBe(201);

    const replay = await h.app.inject({ method: 'POST', url: '/v1/payments', headers: { ...api, 'idempotency-key': key }, payload: body });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().id).toBe(first.json().id);

    const different = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...api, 'idempotency-key': key },
      payload: { ...body, amount: '6.00' },
    });
    expect(different.statusCode).toBe(422);
    expect(different.json().error.code).toBe('idempotency_key_reused');

    const noKey = await h.app.inject({ method: 'POST', url: '/v1/payments', headers: api, payload: body });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('idempotency_key_required');
  });

  it('prevents a second payment for an order that is already paid', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...api, 'idempotency-key': `dup-${randomUUID()}` },
      payload: { amount: '100.00', currency: 'EUR', order_id: 'ORDER-10482', return_url: 'https://shop.test/x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('order_already_paid');
  });

  it('marks a declined card as FAILED and leaves the order unpaid', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...api, 'idempotency-key': `decl-${randomUUID()}` },
      payload: { amount: '20.00', currency: 'EUR', order_id: 'ORDER-DECLINE', return_url: 'https://shop.test/x' },
    });
    const id = create.json().id;
    const token = new URL(create.json().checkout_url).searchParams.get('t');
    const res = await h.app.inject({
      method: 'POST',
      url: `/checkout/sandbox/${id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `t=${token}&outcome=decline`,
    });
    expect(res.statusCode).toBe(303);
    const p = (await h.app.inject({ method: 'GET', url: `/v1/payments/${id}`, headers: api })).json();
    expect(p.status).toBe('FAILED');
    expect(p.failure_reason).toBe('card_declined');

    // Retrying the same order with a new key is allowed once the previous attempt is closed.
    const retry = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...api, 'idempotency-key': `retry-${randomUUID()}` },
      payload: { amount: '20.00', currency: 'EUR', order_id: 'ORDER-DECLINE', return_url: 'https://shop.test/x' },
    });
    expect(retry.statusCode).toBe(201);
  });

  it('serves analytics for the dashboard', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/analytics/summary', headers: dashboard });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settlements.completed).toBeGreaterThanOrEqual(1);
    expect(body.refunds[0].currency).toBe('EUR');
    expect(body.payments.failed).toBeGreaterThanOrEqual(1);
  });

  async function settledStatus(): Promise<string> {
    const { rows } = await h.db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    return rows[0]?.status as string;
  }
});
