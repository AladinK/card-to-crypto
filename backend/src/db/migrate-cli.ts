import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const applied = await migrate(pool);
  logger.info({ applied }, applied.length ? 'migrations applied' : 'database already up to date');
} finally {
  await pool.end();
}
