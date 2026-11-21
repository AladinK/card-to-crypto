import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Container } from '../container.js';
import { sha256Hex } from '../core/security.js';
import { logger } from '../logger.js';
import { installErrorHandling } from './http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMerchantRoutes } from './routes/merchant.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerWalletRoutes } from './routes/wallets.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerCheckoutRoutes } from './routes/checkout.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerSystemRoutes } from './routes/system.js';

export async function buildApp(c: Container): Promise<FastifyInstance> {
  const app = Fastify({
    // Request logging is done by our own hook below, so the shared pino instance is used everywhere.
    logger: false,
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 256 * 1024,
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  // JSON bodies keep their raw bytes: provider and webhook signatures are computed over them.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
    if (body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      const error = new Error('Request body is not valid JSON.') as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });
  // Sandbox checkout form posts.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cors, {
    origin: c.config.dashboardOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-mode'],
    exposedHeaders: ['idempotent-replayed', 'x-request-id'],
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      return auth ? `auth:${sha256Hex(auth)}` : `ip:${request.ip}`;
    },
  });

  installErrorHandling(app, logger);

  // Logs the route pattern, never the raw URL: sandbox checkout links carry a token in the query string.
  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      { reqId: request.id, method: request.method, route: request.routeOptions.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    );
  });

  registerSystemRoutes(app, c);
  registerAuthRoutes(app, c);
  registerMerchantRoutes(app, c);
  registerPaymentRoutes(app, c);
  registerWalletRoutes(app, c);
  registerWebhookRoutes(app, c);
  registerAdminRoutes(app, c);
  registerProviderRoutes(app, c);
  registerCheckoutRoutes(app, c);
  registerAnalyticsRoutes(app, c);

  return app;
}
