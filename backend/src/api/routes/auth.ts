import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { authenticate } from '../auth.js';
import { parseBody } from '../http.js';
import { codeBody, loginBody, refreshBody, registerBody } from '../schemas.js';

const AUTH_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } } as const;

export function registerAuthRoutes(app: FastifyInstance, c: Container): void {
  app.post('/v1/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = parseBody(registerBody, request.body);
    const result = await c.merchants.register({
      merchantName: body.merchant_name,
      email: body.email,
      password: body.password,
      country: body.country ?? null,
      ip: request.ip,
    });
    return reply.code(201).send(result);
  });

  app.post('/v1/auth/login', AUTH_RATE_LIMIT, async (request, reply) => {
    const body = parseBody(loginBody, request.body);
    const result = await c.merchants.login({ email: body.email, password: body.password, totpCode: body.totp_code, ip: request.ip });
    return reply.send(result);
  });

  app.post('/v1/auth/refresh', AUTH_RATE_LIMIT, async (request, reply) => {
    const body = parseBody(refreshBody, request.body);
    return reply.send(await c.merchants.refresh(body.refresh_token));
  });

  app.post('/v1/auth/logout', AUTH_RATE_LIMIT, async (request, reply) => {
    const body = parseBody(refreshBody, request.body);
    await c.merchants.logout(body.refresh_token);
    return reply.code(204).send();
  });

  app.post('/v1/auth/mfa/setup', async (request, reply) => {
    const ctx = await authenticate(c, request);
    if (!ctx.userId) return reply.code(403).send({ error: { code: 'forbidden', message: 'Only dashboard users can set up 2FA.' } });
    return reply.send(await c.merchants.mfaSetup(ctx.userId));
  });

  app.post('/v1/auth/mfa/enable', AUTH_RATE_LIMIT, async (request, reply) => {
    const ctx = await authenticate(c, request);
    if (!ctx.userId) return reply.code(403).send({ error: { code: 'forbidden', message: 'Only dashboard users can enable 2FA.' } });
    const body = parseBody(codeBody, request.body);
    await c.merchants.mfaEnable(ctx.userId, body.code);
    return reply.code(204).send();
  });

  app.get('/v1/me', async (request, reply) => {
    const ctx = await authenticate(c, request);
    return reply.send(await c.merchants.me(ctx));
  });
}
