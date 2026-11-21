import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CardCrypto, CardCryptoError, verifyWebhook, SIGNATURE_HEADER } from '../dist/index.js';

const KEY = 'sk_test_0123456789abcdef_' + 'A'.repeat(43);

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status, body } = handler(String(url), init);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('rejects anything that is not a secret key before making a request', () => {
  assert.throws(() => new CardCrypto({ secretKey: 'pk_test_123' }), /secretKey/);
});

test('creates a payment with the bearer key and a generated idempotency key', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { id: 'pay_1', status: 'PAYMENT_PENDING', checkout_url: 'https://pay.test/c' } }));
  const client = new CardCrypto({ secretKey: KEY, baseUrl: 'https://api.test', fetch: fetchImpl });
  const payment = await client.payments.create({ amount: '100.00', currency: 'EUR', orderId: 'A-1', returnUrl: 'https://shop.test/ok' });
  assert.equal(payment.id, 'pay_1');
  const sent = calls[0];
  assert.equal(sent.url, 'https://api.test/v1/payments');
  assert.equal(sent.init.headers.authorization, `Bearer ${KEY}`);
  assert.match(sent.init.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(sent.init.body), { amount: '100.00', currency: 'EUR', order_id: 'A-1', return_url: 'https://shop.test/ok' });
});

test('surfaces API errors as CardCryptoError with the stable code', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: { code: 'order_already_paid', message: 'Paid.', request_id: 'r1' } } }));
  const client = new CardCrypto({ secretKey: KEY, baseUrl: 'https://api.test', fetch: fetchImpl });
  await assert.rejects(client.payments.retrieve('pay_9'), (error) => error instanceof CardCryptoError && error.code === 'order_already_paid' && error.status === 409);
});

test('verifies webhook signatures and rejects tampering and replays', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', event: 'settlement.confirmed', payment_id: 'pay_1' });
  const now = 1_800_000_000;
  const sig = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
  const header = `t=${now},v1=${sig}`;
  assert.equal(verifyWebhook({ signatureHeader: header, rawBody: body, secret, nowSeconds: now }).event, 'settlement.confirmed');
  assert.throws(() => verifyWebhook({ signatureHeader: header, rawBody: body.replace('pay_1', 'pay_2'), secret, nowSeconds: now }), /Invalid/);
  assert.throws(() => verifyWebhook({ signatureHeader: header, rawBody: body, secret, nowSeconds: now + 600 }), /tolerance/);
  assert.throws(() => verifyWebhook({ signatureHeader: undefined, rawBody: body, secret }), /Missing/);
  assert.equal(SIGNATURE_HEADER, 'CardCrypto-Signature');
});
