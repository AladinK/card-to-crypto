import type { Container } from '../container.js';
import { logger } from '../logger.js';
import { attemptDelivery } from '../webhooks/outbound.js';
import type { JobHandler } from './worker.js';
import type { JobRow } from './queue.js';
import { recoverStaleJobs } from './queue.js';

/** Maps job queues to handlers. Every handler is idempotent and re-reads state before acting. */
export function buildJobHandlers(c: Container): Record<string, JobHandler> {
  const deliveryDeps = {
    db: c.db,
    encryptionKey: c.config.dataEncryptionKey,
    allowPrivateTargets: c.config.webhookAllowPrivateTargets,
  };
  return {
    'payment.capture': async (payload) => {
      await c.payments.runCapture(String(payload.paymentId));
    },
    'payment.cancel_authorization': async (payload) => {
      await c.payments.runCancelAuthorization(String(payload.paymentId));
    },
    'settlement.advance': async (payload) => c.settlements.advance(String(payload.paymentId)),
    'webhook.deliver': async (payload) => {
      await attemptDelivery(deliveryDeps, String(payload.deliveryId));
    },
  };
}

/** Failure accounting that the queue itself cannot know about. */
export async function onJobFailed(c: Container, job: JobRow, message: string, dead: boolean): Promise<void> {
  if (job.queue === 'settlement.advance') {
    const paymentId = String(job.payload.paymentId);
    await c.db.query('UPDATE settlements SET last_error = $2, attempts = attempts + 1, updated_at = now() WHERE payment_id = $1', [
      paymentId,
      message.slice(0, 500),
    ]);
    if (dead) logger.error({ paymentId, err: message }, 'settlement exhausted retries; needs operator action');
  }
  if (job.queue === 'webhook.deliver' && dead) {
    await c.db.query("UPDATE webhook_deliveries SET status = 'DEAD', last_error = $2, updated_at = now() WHERE id = $1", [
      String(job.payload.deliveryId),
      message.slice(0, 500),
    ]);
  }
}

/** Periodic housekeeping, run by the worker roughly every 15 seconds. All steps are safe to repeat. */
export async function runMaintenance(c: Container): Promise<void> {
  await recoverStaleJobs(c.db);
  await c.payments.expireStale();

  // Reconciliation: a settlement that stopped moving (lost job) gets a new advance job.
  await c.db.query(
    `INSERT INTO jobs (queue, payload, dedupe_key, status, run_at)
     SELECT 'settlement.advance', jsonb_build_object('paymentId', p.id), 'settle:' || p.id, 'queued', now()
     FROM payments p JOIN settlements s ON s.payment_id = p.id
     WHERE p.status IN ('CONVERSION_PENDING', 'CONVERSION_COMPLETED', 'CRYPTO_TRANSFER_PENDING', 'CRYPTO_TRANSFER_SUBMITTED', 'CRYPTO_CONFIRMING')
       AND NOT s.hold AND s.updated_at < now() - interval '3 minutes'
     ON CONFLICT DO NOTHING`,
  );

  // Safety net for webhook deliveries whose retry job was lost.
  await c.db.query(
    `INSERT INTO jobs (queue, payload, dedupe_key, status, run_at)
     SELECT 'webhook.deliver', jsonb_build_object('deliveryId', d.id), 'wh:' || d.id, 'queued', now()
     FROM webhook_deliveries d
     WHERE d.status IN ('PENDING', 'RETRYING') AND d.next_attempt_at < now() - interval '2 minutes'
     ON CONFLICT DO NOTHING`,
  );

  // Retention: idempotency keys after 24 h, completed jobs after 7 days.
  await c.db.query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'");
  await c.db.query("DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '7 days'");
}
