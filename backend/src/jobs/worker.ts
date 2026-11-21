import { randomUUID } from 'node:crypto';
import { ResourceBusyError } from '../core/errors.js';
import type { Db } from '../db/pool.js';
import { claimJobs, completeJob, deferJob, failJob, type JobRow } from './queue.js';

export type JobHandler = (payload: Record<string, unknown>) => Promise<{ requeueMs?: number } | void>;

export interface WorkerLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerOptions {
  db: Db;
  handlers: Record<string, JobHandler>;
  log: WorkerLog;
  concurrency?: number;
  pollMs?: number;
  /** Runs roughly every 15 seconds: stale-job recovery, expirations, reconciliation, retention. */
  maintenance?: () => Promise<void>;
  /** Called when a job exhausts its attempts (dead-letter). Use it to update domain state and alert. */
  onDead?: (job: JobRow, error: string) => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polling worker over the PostgreSQL job table. Several instances can run side by side: claiming uses
 * FOR UPDATE SKIP LOCKED, so each job is held by one worker at a time.
 */
export class JobWorker {
  readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private running = false;
  private loop: Promise<void> | null = null;
  private lastMaintenance = 0;

  constructor(private readonly opts: WorkerOptions) {}

  async runOnce(): Promise<number> {
    const jobs = await claimJobs(this.opts.db, this.id, this.opts.concurrency ?? 5);
    await Promise.all(jobs.map((job) => this.execute(job)));
    return jobs.length;
  }

  private async execute(job: JobRow): Promise<void> {
    try {
      const handler = this.opts.handlers[job.queue];
      if (!handler) throw new Error(`No handler registered for queue ${job.queue}.`);
      const result = await handler(job.payload);
      if (result && typeof result.requeueMs === 'number') {
        await deferJob(this.opts.db, job.id, result.requeueMs);
      } else {
        await completeJob(this.opts.db, job.id);
      }
    } catch (error) {
      if (error instanceof ResourceBusyError) {
        await deferJob(this.opts.db, job.id, 2_000);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await failJob(this.opts.db, job, message);
      this.opts.log.warn({ jobId: job.id, queue: job.queue, attempt: job.attempts, outcome, err: message }, 'job failed');
      if (outcome === 'dead') {
        this.opts.log.error({ jobId: job.id, queue: job.queue, err: message }, 'job moved to dead-letter state');
        await this.opts.onDead?.(job, message);
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastMaintenance > 15_000) {
          this.lastMaintenance = Date.now();
          await this.opts.maintenance?.();
        }
        const claimed = await this.runOnce();
        if (claimed === 0) await sleep(this.opts.pollMs ?? 1_000);
      } catch (error) {
        this.opts.log.error({ err: (error as Error).message }, 'worker loop error');
        await sleep(2_000);
      }
    }
  }
}
