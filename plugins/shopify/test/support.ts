import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequestListener } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { buildOAuthMessage } from '../src/crypto/hmac.js';
import type { AppDeps } from '../src/deps.js';
import type { AppStore, ClaimResult, NewOrderMapping, OrderMapping, ShopRecord, WebhookSource } from '../src/db/store.js';
import { silentLogger } from '../src/logger.js';
import type { FetchFn } from '../src/types.js';

export const APP_URL = 'https://app.example.test';
export const SHOP = 'demo-store.myshopify.com';
export const SHOPIFY_API_SECRET = 'shpss-test-0123';
export const CARDCRYPTO_WEBHOOK_SECRET = 'cc-whsec-test-0123456789';
export const CARDCRYPTO_BASE = 'https://api.cardcrypto.test';
export const CARDCRYPTO_API_KEY = `sk_test_0123456789abcdef_${'k'.repeat(43)}`;

/** Environment for loadConfig. Fresh random key material on every call. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_URL,
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/unused',
    SHOPIFY_API_KEY: 'shopify-client-id',
    SHOPIFY_API_SECRET,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    COOKIE_SECRET: randomBytes(32).toString('hex'),
    CARDCRYPTO_API_BASE_URL: CARDCRYPTO_BASE,
    CARDCRYPTO_API_KEY,
    CARDCRYPTO_WEBHOOK_SECRET,
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(testEnv(overrides));
}

/** In-memory AppStore. Test double for the storage port only; the PostgreSQL store is tested separately. */
export class FakeStore implements AppStore {
  readonly shops = new Map<string, ShopRecord>();
  readonly orders = new Map<string, OrderMapping>();
  readonly webhooks = new Map<string, 'processing' | 'done'>();

  async ping(): Promise<void> {}

  async upsertShop(shopDomain: string, accessTokenEnc: string, scopes: string): Promise<void> {
    this.shops.set(shopDomain, { shopDomain, accessTokenEnc, scopes });
  }

  async getShop(shopDomain: string): Promise<ShopRecord | null> {
    return this.shops.get(shopDomain) ?? null;
  }

  async getOrderMapping(shopDomain: string, shopifyOrderId: string): Promise<OrderMapping | null> {
    return this.orders.get(`${shopDomain}|${shopifyOrderId}`) ?? null;
  }

  async insertOrderMapping(mapping: NewOrderMapping): Promise<void> {
    const key = `${mapping.shopDomain}|${mapping.shopifyOrderId}`;
    if (!this.orders.has(key)) {
      this.orders.set(key, { ...mapping, paymentStatus: 'created', markedPaidAt: null });
    }
  }

  async findOrderMappingByPaymentId(paymentId: string): Promise<OrderMapping | null> {
    for (const order of this.orders.values()) {
      if (order.paymentId === paymentId) return order;
    }
    return null;
  }

  async setPaymentStatus(paymentId: string, status: string): Promise<void> {
    const order = await this.findOrderMappingByPaymentId(paymentId);
    if (order && !order.markedPaidAt) order.paymentStatus = status;
  }

  async markOrderPaid(paymentId: string): Promise<void> {
    const order = await this.findOrderMappingByPaymentId(paymentId);
    if (order) {
      order.paymentStatus = 'captured';
      order.markedPaidAt = order.markedPaidAt ?? new Date();
    }
  }

  async claimWebhook(source: WebhookSource, eventId: string): Promise<ClaimResult> {
    const key = `${source}|${eventId}`;
    const state = this.webhooks.get(key);
    if (state === 'done') return 'done';
    if (state === 'processing') return 'busy';
    this.webhooks.set(key, 'processing');
    return 'claimed';
  }

  async completeWebhook(source: WebhookSource, eventId: string): Promise<void> {
    this.webhooks.set(`${source}|${eventId}`, 'done');
  }

  async releaseWebhook(source: WebhookSource, eventId: string): Promise<void> {
    const key = `${source}|${eventId}`;
    if (this.webhooks.get(key) === 'processing') this.webhooks.delete(key);
  }
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface Route {
  match: (url: string) => boolean;
  respond: (call: RecordedCall) => Response | Promise<Response>;
}

/** Fetch stub: records every call and answers from the first matching route. Unmatched calls fail the test. */
export function routedFetch(routes: Route[], calls: RecordedCall[]): FetchFn {
  return async (input, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: RecordedCall = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    const route = routes.find((candidate) => candidate.match(input));
    if (!route) throw new Error(`unexpected outbound request to ${input}`);
    return route.respond(call);
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    config: testConfig(),
    store: new FakeStore(),
    fetch: routedFetch([], []),
    logger: silentLogger,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

export async function startServer(appDeps: AppDeps): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer(createRequestListener(appDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Base64 HMAC that Shopify sends in X-Shopify-Hmac-Sha256. */
export function shopifyWebhookHmac(rawBody: string, secret: string = SHOPIFY_API_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

export function cardCryptoSignature(rawBody: string, timestamp: number, secret: string = CARDCRYPTO_WEBHOOK_SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** Adds a valid `hmac` to an OAuth callback query, computed with the production message builder. */
export function signedOAuthQuery(params: Record<string, string>, secret: string = SHOPIFY_API_SECRET): URLSearchParams {
  const query = new URLSearchParams(params);
  const hmac = createHmac('sha256', secret).update(buildOAuthMessage(query), 'utf8').digest('hex');
  query.set('hmac', hmac);
  return query;
}
