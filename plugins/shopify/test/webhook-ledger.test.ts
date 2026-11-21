import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { applyMigrations } from '../src/db/migrate.js';
import { PgStore } from '../src/db/store.js';

/**
 * PostgreSQL-backed checks. They run only when TEST_DATABASE_URL is set (for example, the
 * cardcrypto_shopify database). Every row they create is keyed by a random run id and removed afterwards.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const runId = randomUUID();
const prefix = `t-${runId}`;

describe('PostgreSQL store (requires TEST_DATABASE_URL)', { skip: databaseUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let pool: pg.Pool;
  let store: PgStore;

  before(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await applyMigrations(pool);
    store = new PgStore(pool);
  });

  after(async () => {
    await pool.query('DELETE FROM processed_webhooks WHERE event_id LIKE $1', [`${prefix}%`]);
    await pool.query('DELETE FROM shops WHERE shop_domain LIKE $1', [`${prefix}%`]);
    await pool.end();
  });

  test('claim, then a concurrent claim is busy, then complete makes it a duplicate', async () => {
    const id = `${prefix}-a`;
    assert.equal(await store.claimWebhook('shopify', id, 'orders/create', 300), 'claimed');
    assert.equal(await store.claimWebhook('shopify', id, 'orders/create', 300), 'busy');
    await store.completeWebhook('shopify', id);
    assert.equal(await store.claimWebhook('shopify', id, 'orders/create', 300), 'done');
  });

  test('releasing a failed claim lets the next delivery process the event', async () => {
    const id = `${prefix}-b`;
    assert.equal(await store.claimWebhook('cardcrypto', id, 'payment.captured', 300), 'claimed');
    await store.releaseWebhook('cardcrypto', id);
    assert.equal(await store.claimWebhook('cardcrypto', id, 'payment.captured', 300), 'claimed');
  });

  test('a stale processing claim (crashed worker) is reclaimed; a fresh one is not', async () => {
    const id = `${prefix}-c`;
    assert.equal(await store.claimWebhook('shopify', id, 'orders/create', 300), 'claimed');
    await pool.query(
      `UPDATE processed_webhooks SET updated_at = now() - interval '1 hour' WHERE source = 'shopify' AND event_id = $1`,
      [id],
    );
    assert.equal(await store.claimWebhook('shopify', id, 'orders/create', 300), 'claimed');
    assert.equal(await store.claimWebhook('shopify', id, 'orders/create', 300), 'busy');
  });

  test('shopify and cardcrypto event ids live in separate namespaces', async () => {
    const id = `${prefix}-d`;
    assert.equal(await store.claimWebhook('shopify', id, 'orders/create', 300), 'claimed');
    assert.equal(await store.claimWebhook('cardcrypto', id, 'payment.captured', 300), 'claimed');
  });

  test('shop, order mapping and payment status: insert-once mapping, and paid is final', async () => {
    const shop = `${prefix}-shop.myshopify.com`;
    const paymentId = `pay_${runId}`;
    await store.upsertShop(shop, 'v1.iv.tag.ct', 'read_orders,write_orders');
    assert.equal((await store.getShop(shop))?.scopes, 'read_orders,write_orders');

    await store.insertOrderMapping({
      shopDomain: shop,
      shopifyOrderId: '5012345678901',
      orderName: '#1001',
      currency: 'EUR',
      amount: '100.00',
      paymentId,
      checkoutUrl: 'https://pay.cardcrypto.test/c/one',
    });
    // A second insert for the same order must not overwrite the first mapping.
    await store.insertOrderMapping({
      shopDomain: shop,
      shopifyOrderId: '5012345678901',
      orderName: '#1001',
      currency: 'EUR',
      amount: '100.00',
      paymentId: `${paymentId}_other`,
      checkoutUrl: 'https://pay.cardcrypto.test/c/two',
    });

    const mapping = await store.getOrderMapping(shop, '5012345678901');
    assert.equal(mapping?.paymentId, paymentId);
    assert.equal(mapping?.markedPaidAt, null);

    await store.setPaymentStatus(paymentId, 'failed');
    assert.equal((await store.findOrderMappingByPaymentId(paymentId))?.paymentStatus, 'failed');

    await store.markOrderPaid(paymentId);
    const paid = await store.findOrderMappingByPaymentId(paymentId);
    assert.equal(paid?.paymentStatus, 'captured');
    assert.ok(paid?.markedPaidAt instanceof Date);

    await store.setPaymentStatus(paymentId, 'cancelled');
    assert.equal((await store.findOrderMappingByPaymentId(paymentId))?.paymentStatus, 'captured');
  });

  test('ping succeeds against the live database', async () => {
    await store.ping();
  });
});
