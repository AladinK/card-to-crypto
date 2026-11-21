import type { Pool } from 'pg';

export type WebhookSource = 'shopify' | 'cardcrypto';
/** claimed: process it. done: already processed, acknowledge. busy: another attempt is in flight, ask for a retry. */
export type ClaimResult = 'claimed' | 'done' | 'busy';

export interface ShopRecord {
  shopDomain: string;
  accessTokenEnc: string;
  scopes: string;
}

export interface NewOrderMapping {
  shopDomain: string;
  shopifyOrderId: string;
  orderName: string;
  currency: string;
  amount: string;
  paymentId: string;
  checkoutUrl: string;
}

export interface OrderMapping extends NewOrderMapping {
  paymentStatus: string;
  markedPaidAt: Date | null;
}

/** Everything the app needs from storage. Handlers depend on this interface, not on pg. */
export interface AppStore {
  ping(): Promise<void>;
  upsertShop(shopDomain: string, accessTokenEnc: string, scopes: string): Promise<void>;
  getShop(shopDomain: string): Promise<ShopRecord | null>;
  getOrderMapping(shopDomain: string, shopifyOrderId: string): Promise<OrderMapping | null>;
  insertOrderMapping(mapping: NewOrderMapping): Promise<void>;
  findOrderMappingByPaymentId(paymentId: string): Promise<OrderMapping | null>;
  setPaymentStatus(paymentId: string, status: string): Promise<void>;
  markOrderPaid(paymentId: string): Promise<void>;
  claimWebhook(source: WebhookSource, eventId: string, topic: string, staleAfterSeconds: number): Promise<ClaimResult>;
  completeWebhook(source: WebhookSource, eventId: string): Promise<void>;
  releaseWebhook(source: WebhookSource, eventId: string): Promise<void>;
}

interface OrderRow {
  shop_domain: string;
  shopify_order_id: string;
  order_name: string;
  currency: string;
  amount: string;
  payment_id: string;
  checkout_url: string;
  payment_status: string;
  marked_paid_at: Date | null;
}

function toMapping(row: OrderRow): OrderMapping {
  return {
    shopDomain: row.shop_domain,
    shopifyOrderId: row.shopify_order_id,
    orderName: row.order_name,
    currency: row.currency,
    amount: row.amount,
    paymentId: row.payment_id,
    checkoutUrl: row.checkout_url,
    paymentStatus: row.payment_status,
    markedPaidAt: row.marked_paid_at,
  };
}

const ORDER_COLUMNS = `shop_domain, shopify_order_id, order_name, currency, amount, payment_id, checkout_url, payment_status, marked_paid_at`;

export class PgStore implements AppStore {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async upsertShop(shopDomain: string, accessTokenEnc: string, scopes: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO shops (shop_domain, access_token_enc, scopes, installed_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (shop_domain) DO UPDATE
         SET access_token_enc = EXCLUDED.access_token_enc, scopes = EXCLUDED.scopes, updated_at = now()`,
      [shopDomain, accessTokenEnc, scopes],
    );
  }

  async getShop(shopDomain: string): Promise<ShopRecord | null> {
    const { rows } = await this.pool.query<{ shop_domain: string; access_token_enc: string; scopes: string }>(
      'SELECT shop_domain, access_token_enc, scopes FROM shops WHERE shop_domain = $1',
      [shopDomain],
    );
    const row = rows[0];
    return row ? { shopDomain: row.shop_domain, accessTokenEnc: row.access_token_enc, scopes: row.scopes } : null;
  }

  async getOrderMapping(shopDomain: string, shopifyOrderId: string): Promise<OrderMapping | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders_map WHERE shop_domain = $1 AND shopify_order_id = $2`,
      [shopDomain, shopifyOrderId],
    );
    const row = rows[0];
    return row ? toMapping(row) : null;
  }

  async insertOrderMapping(mapping: NewOrderMapping): Promise<void> {
    await this.pool.query(
      `INSERT INTO orders_map (shop_domain, shopify_order_id, order_name, currency, amount, payment_id, checkout_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (shop_domain, shopify_order_id) DO NOTHING`,
      [
        mapping.shopDomain,
        mapping.shopifyOrderId,
        mapping.orderName,
        mapping.currency,
        mapping.amount,
        mapping.paymentId,
        mapping.checkoutUrl,
      ],
    );
  }

  async findOrderMappingByPaymentId(paymentId: string): Promise<OrderMapping | null> {
    const { rows } = await this.pool.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders_map WHERE payment_id = $1`, [
      paymentId,
    ]);
    const row = rows[0];
    return row ? toMapping(row) : null;
  }

  async setPaymentStatus(paymentId: string, status: string): Promise<void> {
    // Never downgrade an order that is already marked paid in Shopify.
    await this.pool.query(
      `UPDATE orders_map SET payment_status = $2, updated_at = now()
       WHERE payment_id = $1 AND marked_paid_at IS NULL`,
      [paymentId, status],
    );
  }

  async markOrderPaid(paymentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE orders_map
       SET payment_status = 'captured', marked_paid_at = COALESCE(marked_paid_at, now()), updated_at = now()
       WHERE payment_id = $1`,
      [paymentId],
    );
  }

  /**
   * Claims an inbound event for processing. A claim is a 'processing' row. It is released on
   * failure, and reclaimed once it is older than staleAfterSeconds (a crashed worker).
   */
  async claimWebhook(source: WebhookSource, eventId: string, topic: string, staleAfterSeconds: number): Promise<ClaimResult> {
    const claimed = await this.pool.query(
      `INSERT INTO processed_webhooks (source, event_id, topic, status, updated_at)
       VALUES ($1, $2, $3, 'processing', now())
       ON CONFLICT (source, event_id) DO UPDATE
         SET status = 'processing', topic = EXCLUDED.topic, updated_at = now()
         WHERE processed_webhooks.status = 'processing'
           AND processed_webhooks.updated_at < now() - make_interval(secs => $4)
       RETURNING status`,
      [source, eventId, topic, staleAfterSeconds],
    );
    if ((claimed.rowCount ?? 0) > 0) return 'claimed';

    const { rows } = await this.pool.query<{ status: string }>(
      'SELECT status FROM processed_webhooks WHERE source = $1 AND event_id = $2',
      [source, eventId],
    );
    return rows[0]?.status === 'done' ? 'done' : 'busy';
  }

  async completeWebhook(source: WebhookSource, eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE processed_webhooks SET status = 'done', updated_at = now() WHERE source = $1 AND event_id = $2`,
      [source, eventId],
    );
  }

  async releaseWebhook(source: WebhookSource, eventId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM processed_webhooks WHERE source = $1 AND event_id = $2 AND status = 'processing'`,
      [source, eventId],
    );
  }
}
