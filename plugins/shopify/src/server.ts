import { createServer } from 'node:http';
import pg from 'pg';
import { createRequestListener } from './app.js';
import { loadConfig } from './config.js';
import { applyMigrations } from './db/migrate.js';
import { PgStore } from './db/store.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger();

  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on('error', (error) => logger.error('idle database client error', { message: error.message }));

  const applied = await applyMigrations(pool);
  logger.info('migrations checked', { newlyApplied: applied });

  const store = new PgStore(pool);
  const server = createServer(
    createRequestListener({
      config,
      store,
      fetch: (input, init) => fetch(input, init),
      logger,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    }),
  );

  server.listen(config.port, () => {
    logger.info('listening', { port: config.port, appUrl: config.appUrl, apiVersion: config.shopify.apiVersion });
  });

  const shutdown = (): void => {
    logger.info('shutting down');
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  // Never print configuration values here: ConfigError messages name variables only.
  console.error(`startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
