import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { authenticate, merchantFor } from '../auth.js';
import { parseBody } from '../http.js';
import { apiKeyBody, rotateBody, storeBody } from '../schemas.js';

export function registerMerchantRoutes(app: FastifyInstance, c: Container): void {
  app.get('/v1/api-keys', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    return reply.send({ data: await c.merchants.listApiKeys(merchant.id) });
  });

  app.post('/v1/api-keys', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const body = parseBody(apiKeyBody, request.body);
    const key = await c.merchants.createApiKey(ctx, { name: body.name, mode: body.mode });
    return reply.code(201).send(key);
  });

  app.post<{ Params: { id: string } }>('/v1/api-keys/:id/rotate', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const body = parseBody(rotateBody, request.body ?? {});
    return reply.code(201).send(await c.merchants.rotateApiKey(ctx, request.params.id, body.grace_hours));
  });

  app.post<{ Params: { id: string } }>('/v1/api-keys/:id/revoke', async (request, reply) => {
    const ctx = await authenticate(c, request);
    await c.merchants.revokeApiKey(ctx, request.params.id);
    return reply.code(204).send();
  });

  app.get('/v1/stores', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    return reply.send({ data: await c.merchants.listStores(merchant.id) });
  });

  app.post('/v1/stores', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const body = parseBody(storeBody, request.body);
    return reply.code(201).send(await c.merchants.createStore(merchant.id, { name: body.name, platform: body.platform, domain: body.domain ?? null }));
  });
}
