import type { ServerResponse } from 'node:http';
import type { AppDeps } from '../deps.js';
import { sendHtml, sendJson, sendRedirect } from '../http.js';
import { pageHtml } from '../pages.js';
import { normalizeShop } from '../shopify/shop.js';

const ORDER_ID = /^[0-9]{1,20}$/;

/**
 * GET /pay/:orderId?shop=<shop>. Redirects the customer to the Card-to-Crypto checkout for the
 * payment created for that Shopify order. Refuses once the order is already paid, so a stale
 * link cannot start a second charge.
 */
export async function handlePay(deps: AppDeps, url: URL, orderId: string, res: ServerResponse): Promise<void> {
  if (!ORDER_ID.test(orderId)) {
    sendHtml(res, 404, pageHtml('Not found', 'This payment link is not valid.'));
    return;
  }
  const shop = normalizeShop(url.searchParams.get('shop'));
  if (!shop) {
    sendHtml(res, 400, pageHtml('Payment link incomplete', 'This payment link must include the store domain.'));
    return;
  }
  const mapping = await deps.store.getOrderMapping(shop, orderId);
  if (!mapping) {
    sendHtml(res, 404, pageHtml('Not found', 'No payment has been created for this order yet.'));
    return;
  }
  if (mapping.markedPaidAt) {
    sendHtml(res, 200, pageHtml('Already paid', 'This order has already been paid.'));
    return;
  }
  sendRedirect(res, mapping.checkoutUrl);
}

/** GET /return: where the Card-to-Crypto checkout sends the customer afterwards. */
export function handleReturn(res: ServerResponse): void {
  sendHtml(
    res,
    200,
    pageHtml('Thank you', 'Your payment is being processed. You can close this window and return to the store.'),
  );
}

/** GET /healthz: 200 when the database answers, 503 otherwise. */
export async function handleHealth(deps: AppDeps, res: ServerResponse): Promise<void> {
  try {
    await deps.store.ping();
    sendJson(res, 200, { status: 'ok' });
  } catch {
    sendJson(res, 503, { status: 'unavailable' });
  }
}
