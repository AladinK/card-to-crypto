import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildOrderMarkAsPaidBody, markOrderAsPaid, ORDER_MARK_AS_PAID_MUTATION } from '../src/shopify/admin.js';
import { PermanentError, TransientError } from '../src/errors.js';
import { jsonResponse, routedFetch, type RecordedCall } from './support.js';

const SHOP = 'demo-store.myshopify.com';
const ORDER_ID = '5012345678901';
const GID = `gid://shopify/Order/${ORDER_ID}`;

describe('orderMarkAsPaid GraphQL body builder (no network)', () => {
  test('uses the OrderMarkAsPaidInput variable and the order global id', () => {
    const body = buildOrderMarkAsPaidBody(ORDER_ID);
    assert.equal(body.query, ORDER_MARK_AS_PAID_MUTATION);
    assert.ok(body.query.includes('mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!)'));
    assert.ok(body.query.includes('orderMarkAsPaid(input: $input)'));
    assert.deepEqual(body.variables, { input: { id: GID } });
  });

  test('selects userErrors so business errors are visible', () => {
    assert.ok(ORDER_MARK_AS_PAID_MUTATION.includes('userErrors'));
  });

  test('rejects anything that is not a plain numeric order id', () => {
    for (const bad of ['', '12a', '1; DROP', '-5', '1'.repeat(21)]) {
      assert.throws(() => buildOrderMarkAsPaidBody(bad), PermanentError, bad);
    }
  });
});

describe('markOrderAsPaid request shape and outcomes', () => {
  const okBody = { data: { orderMarkAsPaid: { order: { id: GID }, userErrors: [] } } };
  const deps = (fetch: ReturnType<typeof routedFetch>) => ({ fetch, timeoutMs: 5000, apiVersion: '2026-10' });

  test('POSTs the mutation to the versioned Admin endpoint with the access token header', async () => {
    const calls: RecordedCall[] = [];
    const fetchFn = routedFetch(
      [{ match: (url) => url.startsWith(`https://${SHOP}/admin/api/`), respond: () => jsonResponse(200, okBody) }],
      calls,
    );
    await markOrderAsPaid(deps(fetchFn), { shop: SHOP, accessToken: 'shpat_test_token', orderId: ORDER_ID });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.url, `https://${SHOP}/admin/api/2026-10/graphql.json`);
    assert.equal(call?.method, 'POST');
    assert.equal(call?.headers['x-shopify-access-token'], 'shpat_test_token');
    assert.equal(call?.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(call?.body ?? ''), buildOrderMarkAsPaidBody(ORDER_ID));
  });

  test('userErrors are permanent failures with the messages attached', async () => {
    const fetchFn = routedFetch(
      [
        {
          match: () => true,
          respond: () =>
            jsonResponse(200, {
              data: { orderMarkAsPaid: { order: null, userErrors: [{ field: ['id'], message: 'Order is cancelled' }] } },
            }),
        },
      ],
      [],
    );
    await assert.rejects(markOrderAsPaid(deps(fetchFn), { shop: SHOP, accessToken: 't', orderId: ORDER_ID }), (error: unknown) => {
      assert.ok(error instanceof PermanentError);
      assert.equal(error.code, 'shopify_user_error');
      assert.match(error.message, /Order is cancelled/);
      return true;
    });
  });

  test('throttling, server errors, auth problems and network failures are transient', async () => {
    const withStatus = (status: number) =>
      routedFetch([{ match: () => true, respond: () => new Response('{}', { status }) }], []);
    for (const status of [429, 500, 503, 401, 403]) {
      await assert.rejects(markOrderAsPaid(deps(withStatus(status)), { shop: SHOP, accessToken: 't', orderId: ORDER_ID }), TransientError, `HTTP ${status}`);
    }
    const unreachable = routedFetch([{ match: () => true, respond: () => Promise.reject(new Error('socket hang up')) }], []);
    await assert.rejects(markOrderAsPaid(deps(unreachable), { shop: SHOP, accessToken: 't', orderId: ORDER_ID }), TransientError);
  });

  test('GraphQL top-level errors and missing payloads are transient', async () => {
    const graphqlError = routedFetch(
      [{ match: () => true, respond: () => jsonResponse(200, { errors: [{ message: 'Throttled' }] }) }],
      [],
    );
    await assert.rejects(markOrderAsPaid(deps(graphqlError), { shop: SHOP, accessToken: 't', orderId: ORDER_ID }), TransientError);

    const empty = routedFetch([{ match: () => true, respond: () => jsonResponse(200, { data: {} }) }], []);
    await assert.rejects(markOrderAsPaid(deps(empty), { shop: SHOP, accessToken: 't', orderId: ORDER_ID }), TransientError);
  });

  test('the request carries a timeout signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = routedFetch(
      [
        {
          match: () => true,
          respond: () => jsonResponse(200, okBody),
        },
      ],
      [],
    );
    const wrapped: typeof fetchFn = (input, init) => {
      signal = init.signal ?? undefined;
      return fetchFn(input, init);
    };
    await markOrderAsPaid(deps(wrapped), { shop: SHOP, accessToken: 't', orderId: ORDER_ID });
    assert.ok(signal instanceof AbortSignal);
  });
});
