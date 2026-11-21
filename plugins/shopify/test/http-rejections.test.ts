import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { AppStore } from '../src/db/store.js';
import {
  APP_URL,
  cardCryptoSignature,
  deps,
  shopifyWebhookHmac,
  SHOP,
  startServer,
  testConfig,
} from './support.js';

/**
 * Any access to the store throws. Requests that must be refused before touching storage or the
 * network therefore fail loudly if the ordering of checks regresses.
 */
const poisonStore = new Proxy({} as AppStore, {
  get(_target, property) {
    throw new Error(`store touched before verification: ${String(property)}`);
  },
});

const poisonFetch = async (input: string): Promise<Response> => {
  throw new Error(`network touched before verification: ${input}`);
};

const ORDER = JSON.stringify({ id: 5012345678901, name: '#1001', currency: 'EUR', total_price: '100.00' });

describe('requests refused before any storage or network access', () => {
  let baseUrl = '';
  let close: () => Promise<void> = async () => {};

  before(async () => {
    const server = await startServer(
      deps({ config: testConfig({ APP_URL }), store: poisonStore, fetch: poisonFetch }),
    );
    baseUrl = server.baseUrl;
    close = server.close;
  });

  after(async () => {
    await close();
  });

  const shopifyHeaders = (body: string, overrides: Record<string, string> = {}): Record<string, string> => ({
    'content-type': 'application/json',
    'x-shopify-topic': 'orders/create',
    'x-shopify-shop-domain': SHOP,
    'x-shopify-webhook-id': 'wh-http-1',
    'x-shopify-hmac-sha256': shopifyWebhookHmac(body),
    ...overrides,
  });

  test('Shopify webhook without an HMAC header gets 401', async () => {
    const response = await fetch(`${baseUrl}/webhooks/shopify/orders-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-topic': 'orders/create' },
      body: ORDER,
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_hmac' });
  });

  test('Shopify webhook with a wrong HMAC gets 401', async () => {
    const response = await fetch(`${baseUrl}/webhooks/shopify/orders-create`, {
      method: 'POST',
      headers: shopifyHeaders(ORDER, { 'x-shopify-hmac-sha256': shopifyWebhookHmac(ORDER, 'wrong-secret-value') }),
      body: ORDER,
    });
    assert.equal(response.status, 401);
  });

  test('a body altered after signing gets 401', async () => {
    const response = await fetch(`${baseUrl}/webhooks/shopify/orders-create`, {
      method: 'POST',
      headers: shopifyHeaders(ORDER),
      body: ORDER.replace('100.00', '1.00'),
    });
    assert.equal(response.status, 401);
  });

  test('a correctly signed webhook for an unsupported topic gets 404', async () => {
    const response = await fetch(`${baseUrl}/webhooks/shopify/app-uninstalled`, {
      method: 'POST',
      headers: shopifyHeaders(ORDER, { 'x-shopify-topic': 'app/uninstalled' }),
      body: ORDER,
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'unknown_topic' });
  });

  test('a signed webhook whose X-Shopify-Topic header disagrees with the path gets 400', async () => {
    const response = await fetch(`${baseUrl}/webhooks/shopify/orders-create`, {
      method: 'POST',
      headers: shopifyHeaders(ORDER, { 'x-shopify-topic': 'products/update' }),
      body: ORDER,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'topic_mismatch' });
  });

  test('a signed webhook with an invalid shop domain gets 400', async () => {
    const response = await fetch(`${baseUrl}/webhooks/shopify/orders-create`, {
      method: 'POST',
      headers: shopifyHeaders(ORDER, { 'x-shopify-shop-domain': 'evil.example.com' }),
      body: ORDER,
    });
    assert.equal(response.status, 400);
  });

  test('a body over 1 MB is refused with 413 before any parsing', async () => {
    const oversized = 'x'.repeat(1_000_001);
    const response = await fetch(`${baseUrl}/webhooks/shopify/orders-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(response.status, 413);
  });

  test('CardCrypto webhook without a signature gets 401', async () => {
    const response = await fetch(`${baseUrl}/webhooks/cardcrypto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'evt_x', event: 'payment.captured' }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'missing_signature' });
  });

  test('CardCrypto webhook with a timestamp outside the 300 second window gets 401', async () => {
    const body = JSON.stringify({ id: 'evt_old', event: 'payment.captured', payment_id: 'pay_1' });
    const stale = Math.floor(Date.now() / 1000) - 301;
    const response = await fetch(`${baseUrl}/webhooks/cardcrypto`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cardcrypto-signature': cardCryptoSignature(body, stale, testConfig().cardcrypto.webhookSecret),
      },
      body,
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'timestamp_out_of_tolerance' });
  });

  test('OAuth start rejects a non-Shopify host without redirecting', async () => {
    const response = await fetch(`${baseUrl}/auth?shop=evil.com`, { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  });

  test('OAuth start with a valid shop redirects to Shopify and sets a state cookie', async () => {
    const response = await fetch(`${baseUrl}/auth?shop=${SHOP}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.ok((response.headers.get('location') ?? '').startsWith(`https://${SHOP}/admin/oauth/authorize?`));
    assert.match(response.headers.get('set-cookie') ?? '', /^ccs_oauth_state=/);
  });

  test('OAuth callback with a bad HMAC gets 401 and no token request', async () => {
    const response = await fetch(
      `${baseUrl}/auth/callback?shop=${SHOP}&code=abc&state=${'a'.repeat(32)}&timestamp=${Math.floor(Date.now() / 1000)}&hmac=${'0'.repeat(64)}`,
      { redirect: 'manual' },
    );
    assert.equal(response.status, 401);
  });

  test('/pay rejects malformed order ids and a missing shop', async () => {
    assert.equal((await fetch(`${baseUrl}/pay/abc?shop=${SHOP}`, { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${baseUrl}/pay/5012345678901`, { redirect: 'manual' })).status, 400);
  });

  test('/return and unknown paths', async () => {
    assert.equal((await fetch(`${baseUrl}/return`)).status, 200);
    const unknown = await fetch(`${baseUrl}/nope`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not_found' });
  });

  test('healthz reports 503 when the database cannot be reached', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 503);
  });
});
