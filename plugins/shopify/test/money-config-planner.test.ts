import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { loadConfig, parseTokenEncryptionKey } from '../src/config.js';
import { ConfigError, PermanentError } from '../src/errors.js';
import { fromMinorUnits, toMinorUnits } from '../src/money.js';
import { planPaymentForOrder } from '../src/shopify/order-payment.js';
import { APP_URL, SHOP, testEnv } from './support.js';

describe('money helpers', () => {
  test('parses plain non-negative decimals into minor units', () => {
    assert.equal(toMinorUnits('100'), 10000n);
    assert.equal(toMinorUnits('100.5'), 10050n);
    assert.equal(toMinorUnits('100.50'), 10050n);
    assert.equal(toMinorUnits('0.01'), 1n);
    assert.equal(toMinorUnits('0'), 0n);
  });

  test('rejects signs, separators, extra decimals and empty input', () => {
    for (const bad of ['-1.00', '1,00', '1.234', '', ' 1.00', '1e3', '1.', '.5']) {
      assert.equal(toMinorUnits(bad), null, JSON.stringify(bad));
    }
  });

  test('formats minor units with exactly two decimals', () => {
    assert.equal(fromMinorUnits(10050n), '100.50');
    assert.equal(fromMinorUnits(5n), '0.05');
    assert.equal(fromMinorUnits(0n), '0.00');
  });
});

describe('config validation', () => {
  test('loads a complete environment with the documented defaults', () => {
    const config = loadConfig(testEnv({ APP_URL: `${APP_URL}/` }));
    assert.equal(config.appUrl, APP_URL);
    assert.equal(config.shopify.scopes, 'read_orders,write_orders');
    assert.equal(config.shopify.apiVersion, '2026-10');
    assert.equal(config.port, 3000);
    assert.equal(config.tokenEncryptionKey.length, 32);
  });

  test('missing variables are reported by name, and values are never echoed', () => {
    const env = testEnv({ DATABASE_URL: undefined, SHOPIFY_API_SECRET: 'VALUE-THAT-MUST-NOT-LEAK' });
    assert.throws(() => loadConfig(env), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /DATABASE_URL/);
      assert.equal(error.message.includes('VALUE-THAT-MUST-NOT-LEAK'), false);
      return true;
    });
  });

  test('plain http is only allowed for localhost', () => {
    assert.doesNotThrow(() => loadConfig(testEnv({ APP_URL: 'http://localhost:3000' })));
    assert.throws(() => loadConfig(testEnv({ APP_URL: 'http://app.example.test' })), /must use https/);
    assert.throws(() => loadConfig(testEnv({ CARDCRYPTO_API_BASE_URL: 'http://api.example.test' })), /must use https/);
  });

  test('the encryption key must decode to exactly 32 bytes in canonical base64', () => {
    assert.throws(() => parseTokenEncryptionKey(randomBytes(16).toString('base64')), ConfigError);
    assert.throws(() => parseTokenEncryptionKey(`${randomBytes(32).toString('base64')}\n`), ConfigError);
    assert.equal(parseTokenEncryptionKey(randomBytes(32).toString('base64')).length, 32);
  });

  test('scopes must include read_orders and write_orders', () => {
    assert.throws(() => loadConfig(testEnv({ SHOPIFY_SCOPES: 'read_orders' })), /write_orders/);
    assert.equal(loadConfig(testEnv({ SHOPIFY_SCOPES: ' write_orders , read_orders ' })).shopify.scopes, 'write_orders,read_orders');
  });

  test('CardCrypto API keys must be sk_test_ or sk_live_ keys', () => {
    assert.throws(() => loadConfig(testEnv({ CARDCRYPTO_API_KEY: 'pk_test_abcdefghijklmnopqrstuvwxyz' })), /sk_test_ or sk_live_/);
  });

  test('short cookie and webhook secrets are refused', () => {
    assert.throws(() => loadConfig(testEnv({ COOKIE_SECRET: 'short' })), /COOKIE_SECRET/);
    assert.throws(() => loadConfig(testEnv({ CARDCRYPTO_WEBHOOK_SECRET: 'short' })), /CARDCRYPTO_WEBHOOK_SECRET/);
  });
});

describe('order to payment planning (pure)', () => {
  const context = { shop: SHOP, appUrl: APP_URL };
  const order = {
    id: 5012345678901,
    name: '#1001',
    currency: 'EUR',
    total_price: '100.00',
    email: 'buyer@example.com',
    order_status_url: 'https://demo-store.myshopify.com/12345/orders/abc/authenticate',
  };

  test('maps a Shopify order to the backend body with an order-scoped idempotency key', () => {
    const plan = planPaymentForOrder(order, context);
    assert.equal(plan.kind, 'create');
    if (plan.kind !== 'create') return;
    assert.equal(plan.idempotencyKey, 'shopify-order-5012345678901');
    assert.deepEqual(plan.body, {
      amount: '100.00',
      currency: 'EUR',
      order_id: '#1001',
      customer: { email: 'buyer@example.com' },
      description: 'Shopify order #1001',
      return_url: 'https://demo-store.myshopify.com/12345/orders/abc/authenticate',
      metadata: { shopify_order_id: '5012345678901', shopify_shop: SHOP },
    });
  });

  test('normalizes amounts to two decimals and falls back to APP_URL/return without a status URL', () => {
    const plan = planPaymentForOrder({ ...order, total_price: '99.5', order_status_url: undefined }, context);
    assert.equal(plan.kind, 'create');
    if (plan.kind !== 'create') return;
    assert.equal(plan.body.amount, '99.50');
    assert.equal(plan.body.return_url, `${APP_URL}/return`);
  });

  test('omits the customer when the email is missing or invalid', () => {
    for (const email of [null, undefined, 'not-an-email', 'a@b']) {
      const plan = planPaymentForOrder({ ...order, email }, context);
      assert.equal(plan.kind, 'create');
      if (plan.kind === 'create') assert.equal('customer' in plan.body, false, String(email));
    }
  });

  test('currencies outside the backend list are permanent failures', () => {
    assert.throws(() => planPaymentForOrder({ ...order, currency: 'JPY' }, context), (error: unknown) => {
      assert.ok(error instanceof PermanentError);
      assert.equal(error.code, 'unsupported_currency');
      return true;
    });
  });

  test('zero totals create no payment', () => {
    const plan = planPaymentForOrder({ ...order, total_price: '0.00' }, context);
    assert.deepEqual(plan, { kind: 'skip', shopifyOrderId: '5012345678901', reason: 'zero_total' });
  });

  test('malformed totals, ids and payloads are permanent failures', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...order, total_price: '1,00' }, 'invalid_total_price'],
      [{ ...order, total_price: '-5.00' }, 'invalid_total_price'],
      [{ ...order, total_price: '1.234' }, 'invalid_total_price'],
      [{ ...order, id: 'abc' }, 'invalid_order_id'],
      [{ ...order, id: 2 ** 60 }, 'invalid_order_id'],
      [{ ...order, name: '' }, 'invalid_order_name'],
      [null, 'invalid_order_payload'],
      ['text', 'invalid_order_payload'],
    ];
    for (const [payload, code] of cases) {
      assert.throws(() => planPaymentForOrder(payload, context), (error: unknown) => {
        assert.ok(error instanceof PermanentError, code);
        assert.equal(error.code, code);
        return true;
      });
    }
  });
});
