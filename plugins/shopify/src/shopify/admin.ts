import { PermanentError, TransientError } from '../errors.js';
import type { FetchFn } from '../types.js';
import { isRecord } from '../types.js';

/**
 * Admin GraphQL mutation that marks an order as paid. Operation name, argument type
 * (OrderMarkAsPaidInput!, input.id: ID!) and payload (order, userErrors) were checked against
 * third-party copies of the Admin schema and client code, not against shopify.dev (unreachable here).
 */
export const ORDER_MARK_AS_PAID_MUTATION = `mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

export interface GraphqlRequestBody {
  query: string;
  variables: { input: { id: string } };
}

export function orderGlobalId(orderId: string): string {
  if (!/^[0-9]{1,20}$/.test(orderId)) throw new PermanentError('invalid_order_id');
  return `gid://shopify/Order/${orderId}`;
}

/** Pure builder for the request body (no network). */
export function buildOrderMarkAsPaidBody(orderId: string): GraphqlRequestBody {
  return {
    query: ORDER_MARK_AS_PAID_MUTATION,
    variables: { input: { id: orderGlobalId(orderId) } },
  };
}

export function adminGraphqlUrl(shop: string, apiVersion: string): string {
  return `https://${shop}/admin/api/${apiVersion}/graphql.json`;
}

const TRANSIENT_STATUSES = new Set([401, 403, 404, 408, 409, 425, 429]);

/**
 * Calls orderMarkAsPaid for one order. Throws PermanentError for Shopify userErrors and
 * TransientError for throttling, server errors, auth or configuration problems.
 */
export async function markOrderAsPaid(
  deps: { fetch: FetchFn; timeoutMs: number; apiVersion: string },
  input: { shop: string; accessToken: string; orderId: string },
): Promise<void> {
  const body = buildOrderMarkAsPaidBody(input.orderId);
  let response: Response;
  try {
    response = await deps.fetch(adminGraphqlUrl(input.shop, deps.apiVersion), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-shopify-access-token': input.accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch {
    throw new TransientError('shopify_unreachable');
  }

  if (response.status >= 500 || TRANSIENT_STATUSES.has(response.status)) {
    throw new TransientError(`shopify_http_${response.status}`);
  }
  if (!response.ok) {
    throw new PermanentError(`shopify_http_${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TransientError('shopify_invalid_json');
  }
  if (!isRecord(payload)) throw new TransientError('shopify_invalid_payload');

  const graphqlErrors = payload.errors;
  if (Array.isArray(graphqlErrors) && graphqlErrors.length > 0) {
    throw new TransientError('shopify_graphql_error');
  }

  const data = isRecord(payload.data) ? payload.data : null;
  const result = data && isRecord(data.orderMarkAsPaid) ? data.orderMarkAsPaid : null;
  if (!result) throw new TransientError('shopify_missing_result');

  const userErrors = Array.isArray(result.userErrors) ? result.userErrors : [];
  if (userErrors.length > 0) {
    const messages = userErrors
      .map((entry) => (isRecord(entry) && typeof entry.message === 'string' ? entry.message : 'unknown'))
      .join('; ')
      .slice(0, 300);
    throw new PermanentError('shopify_user_error', messages);
  }

  const order = isRecord(result.order) ? result.order : null;
  if (!order || typeof order.id !== 'string') throw new TransientError('shopify_missing_order');
}
