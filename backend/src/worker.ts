import { loadConfig } from './config.js';
import { buildContainer } from './container.js';
import { logger } from './logger.js';
import { buildJobHandlers, onJobFailed, runMaintenance } from './jobs/runtime.js';
import { JobWorker } from './jobs/worker.js';
import type { JobRow } from './jobs/queue.js';

const config = loadConfig();
const container = buildContainer(config);
const worker = new JobWorker({
  db: container.db,
  handlers: buildJobHandlers(container),
  log: logger,
  concurrency: 5,
  pollMs: config.workerPollMs,
  maintenance: () => runMaintenance(container),
  onDead: (job: JobRow, message: string) => onJobFailed(container, job, message, true),
});

worker.start();
logger.info({ workerId: worker.id }, 'job worker started');

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'stopping worker');
  await worker.stop();
  await container.db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
