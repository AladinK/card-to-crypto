import pg from 'pg';
import { logger } from '../logger.js';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
/** Anything that can run a query: the pool (autocommit) or a transaction client. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string, max = 10): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
  });
  pool.on('error', (error) => logger.error({ err: error }, 'postgres pool error'));
  return pool;
}

/** Runs `fn` inside BEGIN/COMMIT. Any thrown error rolls the whole unit of work back. */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function toBigInt(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(String(value));
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}
