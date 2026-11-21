import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { readOAuthStateCookie, signOAuthState } from '../src/crypto/hmac.js';
import { PermanentError, TransientError } from '../src/errors.js';
import { buildAuthorizeUrl, exchangeCodeForToken } from '../src/shopify/oauth.js';
import { isValidShopDomain, normalizeShop } from '../src/shopify/shop.js';
import { jsonResponse, routedFetch, SHOP as SHOP_FOR_TESTS, type RecordedCall } from './support.js';

describe('shop domain validation', () => {
  test('accepts <label>.myshopify.com and normalizes to lower case', () => {
    assert.equal(normalizeShop('Demo-Store.myshopify.com'), 'demo-store.myshopify.com');
    assert.equal(normalizeShop(SHOP_FOR_TESTS), SHOP_FOR_TESTS);
  });

  test('rejects lookalike and malformed domains', () => {
    const bad = [
      'evil.com',
      'demo.myshopify.com.evil.com',
      'demo.myshopify.co',
      '-demo.myshopify.com',
      'demo.myshopify.com/admin',
      'demo.myshopify.com?x=1',
      ' demo.myshopify.com',
      'de_mo.myshopify.com',
      '.myshopify.com',
      `${'a'.repeat(300)}.myshopify.com`,
    ];
    for (const value of bad) {
      assert.equal(isValidShopDomain(value), false, value);
      assert.equal(normalizeShop(value), null, value);
    }
    assert.equal(normalizeShop(null), null);
    assert.equal(normalizeShop(undefined), null);
  });
});

describe('OAuth authorize URL', () => {
  test('builds the exact Shopify consent URL', () => {
    const url = buildAuthorizeUrl({
      shop: 'demo-store.myshopify.com',
      apiKey: 'client-id-123',
      scopes: 'read_orders,write_orders',
      redirectUri: 'https://app.example.test/auth/callback',
      state: 'abc123',
    });
    assert.equal(
      url,
      'https://demo-store.myshopify.com/admin/oauth/authorize?client_id=client-id-123&scope=read_orders%2Cwrite_orders&redirect_uri=https%3A%2F%2Fapp.example.test%2Fauth%2Fcallback&state=abc123',
    );
  });
});

describe('OAuth state cookie', () => {
  const secret = randomBytes(32).toString('hex');
  const state = 'f00dfacef00dfacef00dfacef00dface';

  test('round trip for the same shop returns the state', () => {
    const cookie = signOAuthState('demo-store.myshopify.com', state, secret);
    assert.equal(readOAuthStateCookie(cookie, 'demo-store.myshopify.com', secret), state);
  });

  test('the cookie is bound to the shop it was issued for', () => {
    const cookie = signOAuthState('demo-store.myshopify.com', state, secret);
    assert.equal(readOAuthStateCookie(cookie, 'other-store.myshopify.com', secret), null);
  });

  test('forged, tampered, missing or wrongly keyed cookies are rejected', () => {
    const cookie = signOAuthState('demo-store.myshopify.com', state, secret);
    const forged = `${'0'.repeat(32)}.${cookie.split('.')[1]}`;
    assert.equal(readOAuthStateCookie(forged, 'demo-store.myshopify.com', secret), null);
    assert.equal(readOAuthStateCookie(undefined, 'demo-store.myshopify.com', secret), null);
    assert.equal(readOAuthStateCookie('nodot', 'demo-store.myshopify.com', secret), null);
    assert.equal(readOAuthStateCookie(cookie, 'demo-store.myshopify.com', 'another-secret-value'), null);
  });
});

describe('OAuth token exchange request', () => {
  const shop = 'demo-store.myshopify.com';

  test('POSTs the JSON body to /admin/oauth/access_token and returns the token', async () => {
    const calls: RecordedCall[] = [];
    const fetchFn = routedFetch(
      [
        {
          match: (url) => url === `https://${shop}/admin/oauth/access_token`,
          respond: () => jsonResponse(200, { access_token: 'shpat_test_value', scope: 'read_orders,write_orders' }),
        },
      ],
      calls,
    );
    const result = await exchangeCodeForToken(
      { fetch: fetchFn, timeoutMs: 5000 },
      { shop, apiKey: 'client-id', apiSecret: 'client-secret', code: 'code-123' },
    );
    assert.deepEqual(result, { accessToken: 'shpat_test_value', scope: 'read_orders,write_orders' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), {
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'code-123',
      expiring: '0',
    });
  });

  test('error responses map to permanent (400/401) or transient (5xx, bad body) errors', async () => {
    const run = (status: number, body: string) =>
      exchangeCodeForToken(
        {
          fetch: routedFetch(
            [{ match: () => true, respond: () => new Response(body, { status }) }],
            [],
          ),
          timeoutMs: 5000,
        },
        { shop, apiKey: 'k', apiSecret: 's', code: 'c' },
      );
    await assert.rejects(run(400, '{}'), PermanentError);
    await assert.rejects(run(401, '{}'), PermanentError);
    await assert.rejects(run(500, '{}'), TransientError);
    await assert.rejects(run(200, 'not json'), TransientError);
    await assert.rejects(run(200, '{"scope":"read_orders"}'), TransientError);
  });
});
