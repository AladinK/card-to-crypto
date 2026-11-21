import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { handleCardCryptoWebhook } from './handlers/cardcrypto-webhook.js';
import { handleAuthCallback, handleAuthStart } from './handlers/oauth.js';
import { handleHealth, handlePay, handleReturn } from './handlers/pages.js';
import { handleShopifyWebhook } from './handlers/shopify-webhook.js';
import { errorCode, type AppDeps } from './deps.js';
import { BodyTooLargeError } from './errors.js';
import { sendJson } from './http.js';

const SHOPIFY_WEBHOOK_PREFIX = '/webhooks/shopify/';

async function route(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') return handleHealth(deps, res);
  if (method === 'GET' && path === '/auth') return handleAuthStart(deps, url, res);
  if (method === 'GET' && path === '/auth/callback') return handleAuthCallback(deps, req, url, res);
  if (method === 'POST' && path.startsWith(SHOPIFY_WEBHOOK_PREFIX)) {
    return handleShopifyWebhook(deps, req, res, path.slice(SHOPIFY_WEBHOOK_PREFIX.length));
  }
  if (method === 'POST' && path === '/webhooks/cardcrypto') return handleCardCryptoWebhook(deps, req, res);
  const pay = /^\/pay\/([^/]+)$/.exec(path);
  if (method === 'GET' && pay) return handlePay(deps, url, pay[1] ?? '', res);
  if (method === 'GET' && path === '/return') return handleReturn(res);

  sendJson(res, 404, { error: 'not_found' });
}

/** Builds the HTTP request listener. Every route is wired here so tests can run the real router. */
export function createRequestListener(deps: AppDeps): RequestListener {
  return (req, res) => {
    route(deps, req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      deps.logger.error('unhandled request error', {
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        code: errorCode(error),
      });
      sendJson(res, 500, { error: 'internal_error' });
    });
  };
}
