import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { decryptToken } from '../src/crypto/token-crypto.js';
import type { AppConfig } from '../src/config.js';
import {
  APP_URL,
  CARDCRYPTO_API_KEY,
  CARDCRYPTO_BASE,
  cardCryptoSignature,
  deps,
  FakeStore,
  jsonResponse,
  routedFetch,
  shopifyWebhookHmac,
  SHOP,
  signedOAuthQuery,
  startServer,
  testConfig,
  type RecordedCall,
} from './support.js';

const ACCESS_TOKEN = 'shpat_flow_test_token_value';
const GRAPHQL_URL = `https://${SHOP}/admin/api/2026-10/graphql.json`;

/** Mutable behaviour so individual tests can simulate outages. */
const behaviour = {
  paymentsStatus: 201,
  graphqlStatus: 200,
  paymentSequence: 0,
};

interface Ctx {
  config: AppConfig;
  store: FakeStore;
  calls: RecordedCall[];
  baseUrl: string;
  close: () => Promise<void>;
  stateCookie?: string;
}

let ctx: Ctx;

function orderPayload(id: number, total: string, name: string): string {
  return JSON.stringify({
    id,
    name,
    currency: 'EUR',
    total_price: total,
    email: 'buyer@example.com',
    order_status_url: `https://${SHOP}/${id}/orders/status`,
  });
}

async function postShopifyOrder(body: string, webhookId: string, topic = 'orders/create'): Promise<Response> {
  return fetch(`${ctx.baseUrl}/webhooks/shopify/${topic.replace('/', '-')}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-hmac-sha256': shopifyWebhookHmac(body, ctx.config.shopify.apiSecret),
    },
    body,
  });
}

async function postCardCrypto(body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<Response> {
  return fetch(`${ctx.baseUrl}/webhooks/cardcrypto`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cardcrypto-signature': cardCryptoSignature(body, timestamp, ctx.config.cardcrypto.webhookSecret),
    },
    body,
  });
}

function capturedEvent(id: string, paymentId: string, amount: string): string {
  return JSON.stringify({
    id,
    event: 'payment.captured',
    payment_id: paymentId,
    order_id: '#ignored',
    fiat_amount: amount,
    fiat_currency: 'EUR',
    status: 'PAYMENT_CAPTURED',
  });
}

describe('end-to-end flows through the real router (fake store, stubbed Shopify and CardCrypto)', () => {
  before(async () => {
    const config = testConfig({ APP_URL, CARDCRYPTO_API_BASE_URL: CARDCRYPTO_BASE });
    const store = new FakeStore();
    const calls: RecordedCall[] = [];
    const fetchFn = routedFetch(
      [
        {
          match: (url) => url === `https://${SHOP}/admin/oauth/access_token`,
          respond: () => jsonResponse(200, { access_token: ACCESS_TOKEN, scope: 'read_orders,write_orders' }),
        },
        {
          match: (url) => url === `${CARDCRYPTO_BASE}/v1/payments`,
          respond: () => {
            if (behaviour.paymentsStatus !== 201) {
              return jsonResponse(behaviour.paymentsStatus, { error: { code: 'unavailable' } });
            }
            behaviour.paymentSequence += 1;
            const id = `pay_flow_${String(behaviour.paymentSequence).padStart(4, '0')}`;
            return jsonResponse(201, { id, object: 'payment', status: 'PAYMENT_CREATED', checkout_url: `https://pay.cardcrypto.test/c/${id}` });
          },
        },
        {
          match: (url) => url === GRAPHQL_URL,
          respond: () =>
            behaviour.graphqlStatus === 200
              ? jsonResponse(200, { data: { orderMarkAsPaid: { order: { id: 'gid://shopify/Order/1' }, userErrors: [] } } })
              : new Response('{}', { status: behaviour.graphqlStatus }),
        },
      ],
      calls,
    );
    const appDeps = deps({ config, store, fetch: fetchFn });
    const server = await startServer(appDeps);
    ctx = { config, store, calls, baseUrl: server.baseUrl, close: server.close };
  });

  after(async () => {
    await ctx?.close();
  });

  test('1. /auth redirects to Shopify consent and sets a signed, HttpOnly, shop-bound state cookie', async () => {
    const response = await fetch(`${ctx.baseUrl}/auth?shop=${SHOP}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(location.origin + location.pathname, `https://${SHOP}/admin/oauth/authorize`);
    assert.equal(location.searchParams.get('client_id'), ctx.config.shopify.apiKey);
    assert.equal(location.searchParams.get('scope'), 'read_orders,write_orders');
    assert.equal(location.searchParams.get('redirect_uri'), `${APP_URL}/auth/callback`);

    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^ccs_oauth_state=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    const value = /ccs_oauth_state=([^;]+)/.exec(setCookie)?.[1] ?? '';
    assert.equal(value.split('.')[0], location.searchParams.get('state'));
    ctx.stateCookie = value;
  });

  test('2. callback verifies HMAC and state, then stores the token encrypted (never plaintext)', async () => {
    const state = ctx.stateCookie?.split('.')[0] ?? '';
    const query = signedOAuthQuery({
      code: 'auth-code-from-shopify',
      host: Buffer.from(`${SHOP}/admin`).toString('base64'),
      shop: SHOP,
      state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    }, ctx.config.shopify.apiSecret);

    const response = await fetch(`${ctx.baseUrl}/auth/callback?${query.toString()}`, {
      redirect: 'manual',
      headers: { cookie: `ccs_oauth_state=${ctx.stateCookie}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);

    const stored = await ctx.store.getShop(SHOP);
    assert.ok(stored, 'shop row written');
    assert.equal(stored.scopes, 'read_orders,write_orders');
    assert.equal(stored.accessTokenEnc.includes(ACCESS_TOKEN), false);
    assert.equal(decryptToken(stored.accessTokenEnc, SHOP, ctx.config.tokenEncryptionKey), ACCESS_TOKEN);

    const exchange = ctx.calls.find((call) => call.url.endsWith('/admin/oauth/access_token'));
    assert.equal(exchange?.method, 'POST');
  });

  test('3. a valid callback without the state cookie is refused and makes no token request', async () => {
    const before = ctx.calls.length;
    const query = signedOAuthQuery({
      code: 'another-code',
      shop: SHOP,
      state: 'a'.repeat(32),
      timestamp: String(Math.floor(Date.now() / 1000)),
    }, ctx.config.shopify.apiSecret);
    const response = await fetch(`${ctx.baseUrl}/auth/callback?${query.toString()}`, { redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.equal(ctx.calls.length, before);
  });

  test('4. orders/create creates one Card-to-Crypto payment (order-scoped Idempotency-Key) and links it', async () => {
    const response = await postShopifyOrder(orderPayload(5012345678901, '100.00', '#1001'), 'wh-order-1');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'payment_created' });

    const payment = ctx.calls.find((call) => call.url === `${CARDCRYPTO_BASE}/v1/payments`);
    assert.ok(payment, 'payment request made');
    assert.equal(payment.headers.authorization, `Bearer ${CARDCRYPTO_API_KEY}`);
    assert.equal(payment.headers['idempotency-key'], 'shopify-order-5012345678901');
    assert.deepEqual(JSON.parse(payment.body), {
      amount: '100.00',
      currency: 'EUR',
      order_id: '#1001',
      customer: { email: 'buyer@example.com' },
      description: 'Shopify order #1001',
      return_url: `https://${SHOP}/5012345678901/orders/status`,
      metadata: { shopify_order_id: '5012345678901', shopify_shop: SHOP },
    });

    const mapping = await ctx.store.getOrderMapping(SHOP, '5012345678901');
    assert.equal(mapping?.paymentId, 'pay_flow_0001');
    assert.equal(mapping?.checkoutUrl, 'https://pay.cardcrypto.test/c/pay_flow_0001');
  });

  test('5. the same Shopify webhook id again is a duplicate and makes no second payment', async () => {
    const before = ctx.calls.length;
    const response = await postShopifyOrder(orderPayload(5012345678901, '100.00', '#1001'), 'wh-order-1');
    assert.deepEqual(await response.json(), { status: 'duplicate' });
    assert.equal(ctx.calls.length, before);
  });

  test('6. a new delivery for an order that is already linked does not create a second payment', async () => {
    const before = ctx.calls.length;
    const response = await postShopifyOrder(orderPayload(5012345678901, '100.00', '#1001'), 'wh-order-2');
    assert.deepEqual(await response.json(), { status: 'already_linked' });
    assert.equal(ctx.calls.length, before);
  });

  test('7. /pay/<order> redirects the customer to the checkout URL; unknown orders and missing shop fail cleanly', async () => {
    const pay = await fetch(`${ctx.baseUrl}/pay/5012345678901?shop=${SHOP}`, { redirect: 'manual' });
    assert.equal(pay.status, 302);
    assert.equal(pay.headers.get('location'), 'https://pay.cardcrypto.test/c/pay_flow_0001');
    assert.equal(pay.headers.get('cache-control'), 'no-store');

    assert.equal((await fetch(`${ctx.baseUrl}/pay/5012345678901`, { redirect: 'manual' })).status, 400);
    assert.equal((await fetch(`${ctx.baseUrl}/pay/9999999999?shop=${SHOP}`, { redirect: 'manual' })).status, 404);
  });

  test('8. payment.captured marks the Shopify order paid using the decrypted token', async () => {
    const body = capturedEvent('evt_capture_1', 'pay_flow_0001', '100.00');
    const response = await postCardCrypto(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'marked_paid' });

    const mutation = ctx.calls.find((call) => call.url === GRAPHQL_URL);
    assert.ok(mutation, 'GraphQL mutation sent');
    assert.equal(mutation.method, 'POST');
    assert.equal(mutation.headers['x-shopify-access-token'], ACCESS_TOKEN);
    assert.deepEqual(JSON.parse(mutation.body).variables, { input: { id: 'gid://shopify/Order/5012345678901' } });

    const mapping = await ctx.store.getOrderMapping(SHOP, '5012345678901');
    assert.ok(mapping?.markedPaidAt instanceof Date);
  });

  test('9. a replayed payment.captured is a duplicate, and /pay then shows already-paid instead of checkout', async () => {
    const before = ctx.calls.filter((call) => call.url === GRAPHQL_URL).length;
    const response = await postCardCrypto(capturedEvent('evt_capture_1', 'pay_flow_0001', '100.00'));
    assert.deepEqual(await response.json(), { status: 'duplicate' });
    assert.equal(ctx.calls.filter((call) => call.url === GRAPHQL_URL).length, before);

    const pay = await fetch(`${ctx.baseUrl}/pay/5012345678901?shop=${SHOP}`, { redirect: 'manual' });
    assert.equal(pay.status, 200);
    assert.match(await pay.text(), /already been paid/);
  });

  test('10. a captured amount that differs from the order is rejected and Shopify is never called', async () => {
    assert.equal((await postShopifyOrder(orderPayload(5012345678902, '50.00', '#1002'), 'wh-order-3')).status, 200);
    const before = ctx.calls.filter((call) => call.url === GRAPHQL_URL).length;
    const response = await postCardCrypto(capturedEvent('evt_mismatch_1', 'pay_flow_0002', '999.00'));
    assert.deepEqual(await response.json(), { status: 'rejected', code: 'amount_mismatch' });
    assert.equal(ctx.calls.filter((call) => call.url === GRAPHQL_URL).length, before);
    assert.equal((await ctx.store.getOrderMapping(SHOP, '5012345678902'))?.markedPaidAt, null);
  });

  test('11. a Shopify outage during mark-paid answers 500; the retry of the same event then succeeds', async () => {
    assert.equal((await postShopifyOrder(orderPayload(5012345678903, '25.00', '#1003'), 'wh-order-4')).status, 200);
    const body = capturedEvent('evt_flaky_1', 'pay_flow_0003', '25.00');

    behaviour.graphqlStatus = 503;
    const failed = await postCardCrypto(body);
    assert.equal(failed.status, 500);
    assert.equal((await ctx.store.getOrderMapping(SHOP, '5012345678903'))?.markedPaidAt, null);

    behaviour.graphqlStatus = 200;
    const retried = await postCardCrypto(body);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { status: 'marked_paid' });
    assert.ok((await ctx.store.getOrderMapping(SHOP, '5012345678903'))?.markedPaidAt instanceof Date);
  });

  test('12. a CardCrypto outage during payment creation answers 500 to Shopify; the retry creates the payment', async () => {
    behaviour.paymentsStatus = 503;
    const failed = await postShopifyOrder(orderPayload(5012345678904, '12.00', '#1004'), 'wh-order-5');
    assert.equal(failed.status, 500);
    assert.equal(await ctx.store.getOrderMapping(SHOP, '5012345678904'), null);

    behaviour.paymentsStatus = 201;
    const retried = await postShopifyOrder(orderPayload(5012345678904, '12.00', '#1004'), 'wh-order-5');
    assert.deepEqual(await retried.json(), { status: 'payment_created' });
    assert.ok(await ctx.store.getOrderMapping(SHOP, '5012345678904'));
  });

  test('13. payment.failed is recorded on the order and never calls Shopify', async () => {
    const before = ctx.calls.filter((call) => call.url === GRAPHQL_URL).length;
    const body = JSON.stringify({ id: 'evt_failed_1', event: 'payment.failed', payment_id: 'pay_flow_0004' });
    assert.equal((await postCardCrypto(body)).status, 200);
    assert.equal((await ctx.store.getOrderMapping(SHOP, '5012345678904'))?.paymentStatus, 'failed');
    assert.equal(ctx.calls.filter((call) => call.url === GRAPHQL_URL).length, before);
  });

  test('14. settlement.confirmed and unrelated events are acknowledged without side effects', async () => {
    const settlement = JSON.stringify({ id: 'evt_settle_1', event: 'settlement.confirmed', payment_id: 'pay_flow_0001', network: 'polygon', tx_hash: '0xabc' });
    assert.deepEqual(await (await postCardCrypto(settlement)).json(), { status: 'logged' });
    const refund = JSON.stringify({ id: 'evt_refund_1', event: 'refund.completed', payment_id: 'pay_flow_0001' });
    assert.deepEqual(await (await postCardCrypto(refund)).json(), { status: 'ignored' });
  });

  test('15. payment.captured for a payment this app did not create is ignored (the endpoint may be shared)', async () => {
    const body = capturedEvent('evt_foreign_1', 'pay_from_woocommerce', '10.00');
    const response = await postCardCrypto(body);
    assert.deepEqual(await response.json(), { status: 'unknown_payment' });
  });
});
