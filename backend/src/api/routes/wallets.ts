import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { authenticate } from '../auth.js';
import { parseBody } from '../http.js';
import { walletBody, walletVerifyBody } from '../schemas.js';

export function registerWalletRoutes(app: FastifyInstance, c: Container): void {
  app.get('/v1/wallet', async (request, reply) => {
    const ctx = await authenticate(c, request);
    if (!ctx.merchantId) return reply.send({ data: [] });
    return reply.send({ data: await c.wallets.list(ctx.merchantId, ctx.mode) });
  });

  app.post('/v1/wallet', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const body = parseBody(walletBody, request.body);
    return reply.code(201).send(await c.wallets.add(ctx, { blockchain: body.blockchain, asset: body.asset, address: body.address }));
  });

  app.post<{ Params: { id: string } }>('/v1/wallet/:id/verify', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const body = parseBody(walletVerifyBody, request.body);
    return reply.send(await c.wallets.verify(ctx, request.params.id, body.signature));
  });

  app.post<{ Params: { id: string } }>('/v1/wallet/:id/default', async (request, reply) => {
    const ctx = await authenticate(c, request);
    return reply.send(await c.wallets.setDefault(ctx, request.params.id));
  });

  app.post<{ Params: { id: string } }>('/v1/wallet/:id/disable', async (request, reply) => {
    const ctx = await authenticate(c, request);
    await c.wallets.disable(ctx, request.params.id);
    return reply.code(204).send();
  });
}
