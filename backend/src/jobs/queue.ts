import type { Queryable } from '../db/pool.js';

/**
 * PostgreSQL job queue. Jobs are enqueued inside the same transaction as the state change that
 * causes them (transactional outbox): a job exists if and only if its state change committed.
 * Handlers must be idempotent: they re-read state and act only on what is still pending.
 */
export interface JobRow {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  q: Queryable,
  queue: string,
  payload: Record<string, unknown>,
  options: { delayMs?: number; dedupeKey?: string } = {},
): Promise<void> {
  await q.query(
    `INSERT INTO jobs (queue, payload, dedupe_key, status, run_at)
     VALUES ($1, $2, $3, 'queued', now() + ($4::int * interval '1 millisecond'))
     ON CONFLICT DO NOTHING`,
    [queue, JSON.stringify(payload), options.dedupeKey ?? null, options.delayMs ?? 0],
  );
}

export async function claimJobs(db: Queryable, workerId: string, limit: number): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $2, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, queue, payload, attempts, max_attempts`,
    [limit, workerId],
  );
  return rows;
}

export async function completeJob(db: Queryable, id: string): Promise<void> {
  await db.query("UPDATE jobs SET status = 'done', locked_at = NULL, updated_at = now() WHERE id = $1", [id]);
}

/**
 * Reschedules a job without counting the attempt (used when a resource is busy or the step asks to run again).
 * If a newer job with the same dedupe key is already queued, this one is finished: that job covers the work.
 */
export async function deferJob(db: Queryable, id: string, delayMs: number): Promise<void> {
  try {
    await db.query(
      `UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0), run_at = now() + ($2::int * interval '1 millisecond'),
         locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [id, delayMs],
    );
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
    await completeJob(db, id);
  }
}

/** Reschedules after a normal (counted) failure with exponential backoff, or marks the job dead. */
export async function failJob(db: Queryable, job: JobRow, error: string): Promise<'retry' | 'dead'> {
  if (job.attempts >= job.max_attempts) {
    await db.query("UPDATE jobs SET status = 'dead', last_error = $2, locked_at = NULL, updated_at = now() WHERE id = $1", [job.id, error.slice(0, 2000)]);
    return 'dead';
  }
  const backoffMs = Math.min(1_000 * 2 ** Math.min(job.attempts, 10), 15 * 60_000) + Math.floor(Math.random() * 500);
  await db.query(
    `UPDATE jobs SET status = 'queued', last_error = $2, run_at = now() + ($3::int * interval '1 millisecond'),
       locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1`,
    [job.id, error.slice(0, 2000), backoffMs],
  );
  return 'retry';
}

/** Returns jobs whose worker died (lock older than 5 minutes) to the queue. */
export async function recoverStaleJobs(db: Queryable): Promise<number> {
  const result = await db.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`,
  );
  return result.rowCount ?? 0;
}
