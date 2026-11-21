import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { authenticate, merchantFor } from '../auth.js';
import { pagination, parseBody } from '../http.js';
import { webhookEndpointBody } from '../schemas.js';

export function registerWebhookRoutes(app: FastifyInstance, c: Container): void {
  app.get('/v1/webhook-endpoints', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    return reply.send({ data: await c.webhooks.listEndpoints(merchant.id, ctx.mode) });
  });

  app.post('/v1/webhook-endpoints', async (request, reply) => {
    const ctx = await authenticate(c, request);
    await merchantFor(c, ctx);
    const body = parseBody(webhookEndpointBody, request.body);
    return reply.code(201).send(await c.webhooks.createEndpoint(ctx, { url: body.url, events: body.events }));
  });

  app.post<{ Params: { id: string } }>('/v1/webhook-endpoints/:id/rotate-secret', async (request, reply) => {
    const ctx = await authenticate(c, request);
    return reply.send(await c.webhooks.rotateSecret(ctx, request.params.id));
  });

  app.post<{ Params: { id: string } }>('/v1/webhook-endpoints/:id/disable', async (request, reply) => {
    const ctx = await authenticate(c, request);
    await c.webhooks.disableEndpoint(ctx, request.params.id);
    return reply.code(204).send();
  });

  app.get('/v1/webhook-deliveries', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const q = request.query as Record<string, string | undefined>;
    return reply.send({ data: await c.webhooks.listDeliveries(merchant.id, ctx.mode, q.status, pagination(request).limit) });
  });

  app.get<{ Params: { id: string } }>('/v1/webhook-deliveries/:id', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    return reply.send(await c.webhooks.getDelivery(merchant.id, request.params.id));
  });

  app.post<{ Params: { id: string } }>('/v1/webhook-deliveries/:id/replay', async (request, reply) => {
    const ctx = await authenticate(c, request);
    return reply.code(202).send(await c.webhooks.replay(ctx, request.params.id));
  });
}
