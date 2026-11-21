import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPayment, paymentsUrl, type PaymentCreateBody } from '../src/cardcrypto/client.js';
import { PermanentError, TransientError } from '../src/errors.js';
import { CARDCRYPTO_API_KEY, CARDCRYPTO_BASE, jsonResponse, routedFetch, type RecordedCall } from './support.js';

const BODY: PaymentCreateBody = {
  amount: '100.00',
  currency: 'EUR',
  order_id: '#1001',
  customer: { email: 'buyer@example.com' },
  description: 'Shopify order #1001',
  return_url: 'https://demo-store.myshopify.com/12345/orders/abc/authenticate',
  metadata: { shopify_order_id: '5012345678901', shopify_shop: 'demo-store.myshopify.com' },
};

const CREATED = {
  id: 'pay_0123456789abcdef',
  object: 'payment',
  status: 'PAYMENT_CREATED',
  checkout_url: 'https://pay.cardcrypto.test/c/pay_0123456789abcdef',
};

function run(fetchFn: ReturnType<typeof routedFetch>, baseUrl = CARDCRYPTO_BASE) {
  return createPayment(
    { fetch: fetchFn, timeoutMs: 4000 },
    { baseUrl, apiKey: CARDCRYPTO_API_KEY, idempotencyKey: 'shopify-order-5012345678901', body: BODY },
  );
}

describe('Card-to-Crypto POST /v1/payments client', () => {
  test('builds the URL without double slashes, even with a trailing slash on the base', () => {
    assert.equal(paymentsUrl('https://api.cardcrypto.test/'), 'https://api.cardcrypto.test/v1/payments');
    assert.equal(paymentsUrl('https://api.cardcrypto.test'), 'https://api.cardcrypto.test/v1/payments');
  });

  test('sends bearer auth, the Idempotency-Key header and the exact JSON body', async () => {
    const calls: RecordedCall[] = [];
    const fetchFn = routedFetch(
      [{ match: (url) => url.endsWith('/v1/payments'), respond: () => jsonResponse(201, CREATED) }],
      calls,
    );
    const payment = await run(fetchFn, `${CARDCRYPTO_BASE}/`);

    assert.deepEqual(payment, {
      id: 'pay_0123456789abcdef',
      status: 'PAYMENT_CREATED',
      checkoutUrl: 'https://pay.cardcrypto.test/c/pay_0123456789abcdef',
    });
    const [call] = calls;
    assert.equal(call?.url, `${CARDCRYPTO_BASE}/v1/payments`);
    assert.equal(call?.method, 'POST');
    assert.equal(call?.headers.authorization, `Bearer ${CARDCRYPTO_API_KEY}`);
    assert.equal(call?.headers['idempotency-key'], 'shopify-order-5012345678901');
    assert.deepEqual(JSON.parse(call?.body ?? ''), BODY);
  });

  test('a replayed response (idempotent-replayed) is accepted as success', async () => {
    const fetchFn = routedFetch(
      [
        {
          match: () => true,
          respond: () =>
            new Response(JSON.stringify(CREATED), {
              status: 201,
              headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
            }),
        },
      ],
      [],
    );
    assert.equal((await run(fetchFn)).id, 'pay_0123456789abcdef');
  });

  test('backend validation errors (400/422) are permanent; overload and outages are transient', async () => {
    const withStatus = (status: number) =>
      routedFetch([{ match: () => true, respond: () => jsonResponse(status, { error: { code: 'invalid' } }) }], []);
    await assert.rejects(run(withStatus(422)), PermanentError);
    await assert.rejects(run(withStatus(400)), PermanentError);
    await assert.rejects(run(withStatus(503)), TransientError);
    await assert.rejects(run(withStatus(429)), TransientError);
    await assert.rejects(run(withStatus(409)), TransientError);

    const unreachable = routedFetch([{ match: () => true, respond: () => Promise.reject(new Error('ECONNRESET')) }], []);
    await assert.rejects(run(unreachable), TransientError);
  });

  test('a success response without an id or a usable checkout_url is transient', async () => {
    const bad = (payload: unknown) => routedFetch([{ match: () => true, respond: () => jsonResponse(201, payload) }], []);
    await assert.rejects(run(bad({ status: 'PAYMENT_CREATED', checkout_url: CREATED.checkout_url })), TransientError);
    await assert.rejects(run(bad({ id: 'pay_1', status: 'x' })), TransientError);
    await assert.rejects(run(bad({ id: 'pay_1', checkout_url: 'javascript:alert(1)' })), TransientError);
    await assert.rejects(run(bad({ id: 'pay_1', checkout_url: 'not a url' })), TransientError);
  });
});
