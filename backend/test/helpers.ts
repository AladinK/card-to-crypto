import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { buildContainer, type Container } from '../src/container.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildJobHandlers } from '../src/jobs/runtime.js';
import { JobWorker } from '../src/jobs/worker.js';

export const silentLog = { info() {}, warn() {}, error() {} };

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database for integration tests.');
  return url;
}

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DASHBOARD_ORIGINS: 'http://localhost:3001',
    DATABASE_URL: testDatabaseUrl(),
    JWT_SECRET: 'test-jwt-secret-with-more-than-32-characters',
    API_KEY_PEPPER: 'test-api-key-pepper-with-more-than-32-characters',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
    SANDBOX_BLOCK_TIME_MS: '40',
    SANDBOX_INCLUSION_DELAY_MS: '40',
    WALLET_ACTIVATION_DELAY_HOURS: '0',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(testEnv(overrides));
}

export interface TestHarness {
  app: FastifyInstance;
  container: Container;
  config: AppConfig;
  db: Db;
  /** Runs queued jobs until `done()` is true or the budget is spent. */
  drain(done?: () => Promise<boolean>, maxRounds?: number): Promise<void>;
  close(): Promise<void>;
}

/** Fresh schema + migrations + full application, bound to the test database. */
export async function createHarness(overrides: Record<string, string> = {}): Promise<TestHarness> {
  const config = testConfig(overrides);
  const db = createPool(config.databaseUrl, 5);
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const container = buildContainer(config, db);
  const app = await buildApp(container);
  await app.ready();
  const worker = new JobWorker({ db, handlers: buildJobHandlers(container), log: silentLog, concurrency: 5, pollMs: 10 });
  return {
    app,
    container,
    config,
    db,
    async drain(done, maxRounds = 300) {
      for (let round = 0; round < maxRounds; round++) {
        await worker.runOnce();
        if (done && (await done())) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    },
    async close() {
      await app.close();
      await db.end();
    },
  };
}

export interface Receiver {
  url: string;
  requests: Array<{ headers: IncomingMessage['headers']; body: string }>;
  /** Next N responses use this status (default 200). */
  failNext(count: number, status?: number): void;
  close(): Promise<void>;
}

/** Local HTTP sink that records webhook deliveries (test-only; production blocks private targets). */
export async function startReceiver(): Promise<Receiver> {
  const requests: Receiver['requests'] = [];
  let failures: { count: number; status: number } = { count: 0, status: 500 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      const status = failures.count > 0 ? failures.status : 200;
      if (failures.count > 0) failures.count--;
      res.statusCode = status;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hooks/cardcrypto`,
    requests,
    failNext(count, status = 500) {
      failures = { count, status };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Verifies a CardCrypto-Signature header the way a merchant would (test oracle, independent of src). */
export function expectedSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
