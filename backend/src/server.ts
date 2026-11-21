import { loadConfig } from './config.js';
import { buildContainer } from './container.js';
import { buildApp } from './api/app.js';
import { logger } from './logger.js';

const config = loadConfig();
const container = buildContainer(config);
const app = await buildApp(container);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down API');
  await app.close();
  await container.db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: process.env.HOST ?? '0.0.0.0' });
logger.info({ port: config.port, env: config.env, liveConfigured: container.liveConfigured }, 'API listening');
