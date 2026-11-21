import type { PaymentCreateBody } from '../cardcrypto/client.js';
import { PermanentError } from '../errors.js';
import { fromMinorUnits, isDecimalAmount, toMinorUnits } from '../money.js';
import { isRecord } from '../types.js';
import { isHttpUrl, isValidEmail } from '../util.js';

/** Mirrors FIAT_CURRENCIES in backend/src/core/money.ts. Orders in other currencies cannot be paid. */
export const SUPPORTED_FIAT_CURRENCIES: readonly string[] = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'RSD'];

export type OrderPaymentPlan =
  | {
      kind: 'create';
      shopifyOrderId: string;
      orderName: string;
      currency: string;
      amount: string;
      idempotencyKey: string;
      body: PaymentCreateBody;
    }
  | { kind: 'skip'; shopifyOrderId: string; reason: 'zero_total' };

/**
 * Turns an orders/create payload into the body for POST /v1/payments. Pure: no network, no database.
 * Amount and currency come from total_price and currency (see README for the presentment-currency caveat).
 */
export function planPaymentForOrder(order: unknown, context: { shop: string; appUrl: string }): OrderPaymentPlan {
  if (!isRecord(order)) throw new PermanentError('invalid_order_payload');

  const rawId = order.id;
  const orderId =
    typeof rawId === 'number' && Number.isSafeInteger(rawId)
      ? String(rawId)
      : typeof rawId === 'string'
        ? rawId
        : '';
  if (!/^[0-9]{1,20}$/.test(orderId)) throw new PermanentError('invalid_order_id');

  const name = typeof order.name === 'string' ? order.name.trim() : '';
  if (name.length === 0 || name.length > 128) throw new PermanentError('invalid_order_name');

  const currency = typeof order.currency === 'string' ? order.currency : '';
  if (!SUPPORTED_FIAT_CURRENCIES.includes(currency)) {
    throw new PermanentError('unsupported_currency', `order currency ${currency.slice(0, 10) || '(missing)'} is not supported`);
  }

  const total = typeof order.total_price === 'string' ? order.total_price.trim() : '';
  if (!isDecimalAmount(total)) throw new PermanentError('invalid_total_price');
  const minor = toMinorUnits(total);
  if (minor === null) throw new PermanentError('invalid_total_price');
  if (minor === 0n) return { kind: 'skip', shopifyOrderId: orderId, reason: 'zero_total' };

  const statusUrl = order.order_status_url;
  const returnUrl = isHttpUrl(statusUrl) ? statusUrl : `${context.appUrl}/return`;

  const body: PaymentCreateBody = {
    amount: fromMinorUnits(minor),
    currency,
    order_id: name,
    return_url: returnUrl,
    description: `Shopify order ${name}`.slice(0, 250),
    metadata: { shopify_order_id: orderId, shopify_shop: context.shop },
  };
  const email = order.email;
  if (isValidEmail(email)) body.customer = { email };

  return {
    kind: 'create',
    shopifyOrderId: orderId,
    orderName: name,
    currency,
    amount: body.amount,
    idempotencyKey: `shopify-order-${orderId}`,
    body,
  };
}
