import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { AppError } from '../../core/errors.js';

type RawRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Inbound provider webhooks. The raw body is verified before any JSON is trusted. Responses are 2xx
 * only after the event is durably recorded, so the provider's retries are safe (dedupe by event id).
 */
export function registerProviderRoutes(app: FastifyInstance, c: Container): void {
  app.post('/webhooks/providers/stripe', async (request, reply) => {
    let provider;
    try {
      provider = c.providerFor('live');
    } catch {
      return reply.code(404).send({ error: { code: 'not_configured', message: 'Stripe is not configured.' } });
    }
    if (provider.name !== 'stripe') return reply.code(404).send({ error: { code: 'not_configured', message: 'Stripe is not configured.' } });

    const raw = (request as RawRequest).rawBody ?? Buffer.alloc(0);
    let events;
    try {
      events = provider.handleWebhook(raw, request.headers as Record<string, string | string[] | undefined>);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as Error).name === 'StripeSignatureVerificationError') {
        throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed.');
      }
      throw error;
    }
    const summary = await c.payments.ingest('stripe', events);
    return reply.code(200).send({ received: true, ...summary });
  });

  /** Sandbox event simulator. Not available in production. */
  app.post('/webhooks/providers/sandbox', async (request, reply) => {
    if (c.config.isProduction) return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } });
    const raw = (request as RawRequest).rawBody ?? Buffer.alloc(0);
    const events = c.sandboxProvider.handleWebhook(raw, request.headers as Record<string, string | string[] | undefined>);
    const summary = await c.payments.ingest('sandbox', events);
    return reply.code(200).send({ received: true, ...summary });
  });
}
