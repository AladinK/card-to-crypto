import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';

const OPENAPI_PATH = new URL('../../../../docs/openapi.yaml', import.meta.url);

export function registerSystemRoutes(app: FastifyInstance, c: Container): void {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (request, reply) => {
    try {
      await c.db.query('SELECT 1');
      return reply.send({ status: 'ready', database: 'ok', live_configured: c.liveConfigured });
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'down' });
    }
  });

  app.get('/openapi.yaml', async (request, reply) => {
    const spec = await readFile(OPENAPI_PATH, 'utf8');
    return reply.type('application/yaml; charset=utf-8').send(spec);
  });
}
