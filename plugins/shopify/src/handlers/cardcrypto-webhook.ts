import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyCardCryptoSignature } from '../crypto/hmac.js';
import { decryptToken } from '../crypto/token-crypto.js';
import { claimTtl, errorCode, type AppDeps } from '../deps.js';
import { isPermanentError, PermanentError, TransientError } from '../errors.js';
import { header, readRawBody, sendJson } from '../http.js';
import { toMinorUnits } from '../money.js';
import { markOrderAsPaid } from '../shopify/admin.js';
import { isRecord } from '../types.js';
import { MAX_WEBHOOK_BYTES } from './shopify-webhook.js';

/**
 * POST /webhooks/cardcrypto. Verifies CardCrypto-Signature over the raw body, dedupes by the
 * event id, then acts on payment.captured (mark the Shopify order paid) and records the others.
 */
export async function handleCardCryptoWebhook(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRawBody(req, MAX_WEBHOOK_BYTES);

  const verdict = verifyCardCryptoSignature({
    header: header(req, 'cardcrypto-signature'),
    rawBody: raw,
    secret: deps.config.cardcrypto.webhookSecret,
    nowSeconds: deps.nowSeconds(),
  });
  if (!verdict.ok) {
    deps.logger.warn('cardcrypto webhook rejected', { reason: verdict.reason });
    sendJson(res, 401, { error: verdict.reason });
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (
    !isRecord(event) ||
    typeof event.id !== 'string' ||
    event.id.length === 0 ||
    event.id.length > 200 ||
    typeof event.event !== 'string'
  ) {
    sendJson(res, 400, { error: 'invalid_event' });
    return;
  }
  const eventId = event.id;
  const eventType = event.event;

  const claim = await deps.store.claimWebhook('cardcrypto', eventId, eventType, claimTtl(deps));
  if (claim === 'done') {
    sendJson(res, 200, { status: 'duplicate' });
    return;
  }
  if (claim === 'busy') {
    sendJson(res, 409, { error: 'in_progress' });
    return;
  }

  try {
    const status = await handleCardCryptoEvent(deps, eventType, event);
    await deps.store.completeWebhook('cardcrypto', eventId);
    sendJson(res, 200, { status });
  } catch (error) {
    if (isPermanentError(error)) {
      await deps.store.completeWebhook('cardcrypto', eventId);
      deps.logger.error('cardcrypto event rejected permanently', { eventId, eventType, code: error.code });
      sendJson(res, 200, { status: 'rejected', code: error.code });
      return;
    }
    await deps.store.releaseWebhook('cardcrypto', eventId).catch(() => undefined);
    deps.logger.error('cardcrypto event failed; CardCrypto will retry', {
      eventId,
      eventType,
      code: errorCode(error),
    });
    sendJson(res, 500, { error: 'processing_failed' });
  }
}

export async function handleCardCryptoEvent(deps: AppDeps, eventType: string, event: Record<string, unknown>): Promise<string> {
  switch (eventType) {
    case 'payment.captured':
      return markCapturedOrderPaid(deps, event);
    case 'payment.failed':
    case 'payment.cancelled': {
      const paymentId = typeof event.payment_id === 'string' ? event.payment_id : null;
      if (paymentId) {
        await deps.store.setPaymentStatus(paymentId, eventType === 'payment.failed' ? 'failed' : 'cancelled');
      }
      return 'recorded';
    }
    case 'settlement.confirmed':
      // Shopify note with network and tx_hash is not added: the field was not verified against the Admin schema.
      deps.logger.info('settlement confirmed; no Shopify note added', {
        paymentId: typeof event.payment_id === 'string' ? event.payment_id : null,
        network: typeof event.network === 'string' ? event.network : null,
      });
      return 'logged';
    default:
      return 'ignored';
  }
}

async function markCapturedOrderPaid(deps: AppDeps, event: Record<string, unknown>): Promise<string> {
  const paymentId = typeof event.payment_id === 'string' ? event.payment_id : '';
  if (paymentId.length === 0) throw new PermanentError('missing_payment_id');

  const mapping = await deps.store.findOrderMappingByPaymentId(paymentId);
  if (!mapping) {
    deps.logger.warn('payment.captured for a payment this app did not create; ignored', { paymentId });
    return 'unknown_payment';
  }
  if (mapping.markedPaidAt) return 'already_marked_paid';

  // Only mark the Shopify order paid when the captured amount and currency match the order we created.
  const capturedMinor = typeof event.fiat_amount === 'string' ? toMinorUnits(event.fiat_amount) : null;
  const expectedMinor = toMinorUnits(mapping.amount);
  if (
    event.fiat_currency !== mapping.currency ||
    capturedMinor === null ||
    expectedMinor === null ||
    capturedMinor !== expectedMinor
  ) {
    throw new PermanentError('amount_mismatch', `captured amount does not match order ${mapping.orderName}`);
  }

  const shop = await deps.store.getShop(mapping.shopDomain);
  if (!shop) throw new PermanentError('shop_not_installed');

  let accessToken: string;
  try {
    accessToken = decryptToken(shop.accessTokenEnc, shop.shopDomain, deps.config.tokenEncryptionKey);
  } catch {
    throw new TransientError('token_unreadable', 'stored token could not be decrypted; check TOKEN_ENCRYPTION_KEY');
  }

  await markOrderAsPaid(
    {
      fetch: deps.fetch,
      timeoutMs: deps.config.shopify.timeoutMs,
      apiVersion: deps.config.shopify.apiVersion,
    },
    { shop: shop.shopDomain, accessToken, orderId: mapping.shopifyOrderId },
  );
  await deps.store.markOrderPaid(paymentId);
  deps.logger.info('shopify order marked as paid', {
    shop: shop.shopDomain,
    shopifyOrderId: mapping.shopifyOrderId,
    paymentId,
  });
  return 'marked_paid';
}
