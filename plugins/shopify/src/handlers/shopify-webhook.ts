import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPayment } from '../cardcrypto/client.js';
import { verifyShopifyWebhookHmac } from '../crypto/hmac.js';
import { claimTtl, errorCode, type AppDeps } from '../deps.js';
import { isPermanentError, PermanentError } from '../errors.js';
import { header, readRawBody, sendJson } from '../http.js';
import { planPaymentForOrder } from '../shopify/order-payment.js';
import { normalizeShop } from '../shopify/shop.js';

export const MAX_WEBHOOK_BYTES = 1_000_000;

/** Topics this app subscribes to. Anything else is rejected with 404. */
export const SUPPORTED_SHOPIFY_TOPICS: ReadonlySet<string> = new Set(['orders/create']);

/** Path segment "orders-create" (or "orders%2Fcreate") -> topic "orders/create". */
export function topicFromSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return decoded.replace(/-/g, '/');
}

/**
 * POST /webhooks/shopify/:topic. The HMAC is checked on the raw body before anything is parsed.
 * Responses: 200 processed/duplicate/rejected-permanently, 409 in flight, 500 retry, 401 bad signature.
 */
export async function handleShopifyWebhook(
  deps: AppDeps,
  req: IncomingMessage,
  res: ServerResponse,
  topicSegment: string,
): Promise<void> {
  const raw = await readRawBody(req, MAX_WEBHOOK_BYTES);

  if (!verifyShopifyWebhookHmac(raw, header(req, 'x-shopify-hmac-sha256'), deps.config.shopify.apiSecret)) {
    deps.logger.warn('shopify webhook rejected: invalid hmac', { path: topicSegment.slice(0, 64) });
    sendJson(res, 401, { error: 'invalid_hmac' });
    return;
  }

  const topic = topicFromSegment(topicSegment);
  if (!topic || !SUPPORTED_SHOPIFY_TOPICS.has(topic)) {
    sendJson(res, 404, { error: 'unknown_topic' });
    return;
  }
  if (header(req, 'x-shopify-topic') !== topic) {
    sendJson(res, 400, { error: 'topic_mismatch' });
    return;
  }

  const shop = normalizeShop(header(req, 'x-shopify-shop-domain'));
  if (!shop) {
    sendJson(res, 400, { error: 'invalid_shop_domain' });
    return;
  }
  const webhookId = header(req, 'x-shopify-webhook-id');
  if (!webhookId || webhookId.length > 200) {
    sendJson(res, 400, { error: 'missing_webhook_id' });
    return;
  }

  const claim = await deps.store.claimWebhook('shopify', webhookId, topic, claimTtl(deps));
  if (claim === 'done') {
    sendJson(res, 200, { status: 'duplicate' });
    return;
  }
  if (claim === 'busy') {
    sendJson(res, 409, { error: 'in_progress' });
    return;
  }

  try {
    const status = await processShopifyWebhook(deps, topic, shop, raw);
    await deps.store.completeWebhook('shopify', webhookId);
    sendJson(res, 200, { status });
  } catch (error) {
    if (isPermanentError(error)) {
      await deps.store.completeWebhook('shopify', webhookId);
      deps.logger.error('shopify webhook rejected permanently', { topic, shop, webhookId, code: error.code });
      sendJson(res, 200, { status: 'rejected', code: error.code });
      return;
    }
    await deps.store.releaseWebhook('shopify', webhookId).catch(() => undefined);
    deps.logger.error('shopify webhook failed; Shopify will retry', {
      topic,
      shop,
      webhookId,
      code: errorCode(error),
    });
    sendJson(res, 500, { error: 'processing_failed' });
  }
}

async function processShopifyWebhook(deps: AppDeps, topic: string, shop: string, raw: Buffer): Promise<string> {
  if (topic !== 'orders/create') throw new PermanentError('unsupported_topic');

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PermanentError('invalid_json');
  }

  const plan = planPaymentForOrder(payload, { shop, appUrl: deps.config.appUrl });
  if (plan.kind === 'skip') {
    deps.logger.info('order has no amount to collect; no payment created', {
      shop,
      shopifyOrderId: plan.shopifyOrderId,
    });
    return 'skipped_zero_total';
  }

  const installed = await deps.store.getShop(shop);
  if (!installed) throw new PermanentError('shop_not_installed');

  const existing = await deps.store.getOrderMapping(shop, plan.shopifyOrderId);
  if (existing) return 'already_linked';

  const payment = await createPayment(
    { fetch: deps.fetch, timeoutMs: deps.config.cardcrypto.timeoutMs },
    {
      baseUrl: deps.config.cardcrypto.baseUrl,
      apiKey: deps.config.cardcrypto.apiKey,
      idempotencyKey: plan.idempotencyKey,
      body: plan.body,
    },
  );

  await deps.store.insertOrderMapping({
    shopDomain: shop,
    shopifyOrderId: plan.shopifyOrderId,
    orderName: plan.orderName,
    currency: plan.currency,
    amount: plan.amount,
    paymentId: payment.id,
    checkoutUrl: payment.checkoutUrl,
  });
  deps.logger.info('payment created for shopify order', {
    shop,
    shopifyOrderId: plan.shopifyOrderId,
    paymentId: payment.id,
    status: payment.status,
  });
  return 'payment_created';
}
