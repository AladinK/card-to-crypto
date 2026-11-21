import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { err } from '../../core/errors.js';
import { authenticate, merchantFor } from '../auth.js';

/** Dashboard KPIs. Default window: the last 30 days. */
export function registerAnalyticsRoutes(app: FastifyInstance, c: Container): void {
  app.get('/v1/analytics/summary', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const q = request.query as Record<string, string | undefined>;
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw err.unprocessable('invalid_range', 'from and to must be valid ISO dates with from <= to.');
    }
    return reply.send(await c.analytics.summary(merchant.id, ctx.mode, { from, to }));
  });
}
