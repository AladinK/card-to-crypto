import { decryptSecret, newId, signWebhookPayload } from '../core/security.js';
import type { Mode } from '../core/types.js';
import { withTransaction, type Db, type Tx, type Queryable } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { safePost } from './net.js';

export const WEBHOOK_EVENT_TYPES = [
  'payment.created',
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'payment.cancelled',
  'conversion.completed',
  'settlement.created',
  'settlement.confirmed',
  'settlement.failed',
  'refund.created',
  'refund.completed',
  'refund.failed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_API_VERSION = '2026-11-01';
/** Delay before attempt n+1 (index n). After the last entry the delivery is dead (dead-letter queue). */
export const WEBHOOK_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 43_200_000];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length + 1;

export interface EmitInput {
  merchantId: string;
  mode: Mode;
  type: WebhookEventType;
  paymentId: string | null;
  /** Top-level summary fields, e.g. payment_id, order_id, fiat_amount, tx_hash (see docs/API.md). */
  summary: Record<string, string | number | null>;
  /** Full resource snapshot, placed under data.object. */
  object: Record<string, unknown>;
}

/**
 * Transactional outbox: writes the event and one delivery per matching endpoint inside the caller's
 * transaction. If the business change rolls back, no event is sent.
 */
export async function emitEvent(tx: Tx, input: EmitInput): Promise<string> {
  const eventId = newId('evt');
  const createdAt = new Date().toISOString();
  const payload = {
    id: eventId,
    event: input.type,
    api_version: WEBHOOK_API_VERSION,
    created_at: createdAt,
    mode: input.mode,
    livemode: input.mode === 'live',
    payment_id: input.paymentId,
    ...input.summary,
    data: { object: input.object },
  };
  await tx.query(
    'INSERT INTO webhook_events (id, merchant_id, mode, type, payment_id, payload) VALUES ($1, $2, $3, $4, $5, $6)',
    [eventId, input.merchantId, input.mode, input.type, input.paymentId, JSON.stringify(payload)],
  );

  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
     WHERE merchant_id = $1 AND mode = $2 AND status = 'ACTIVE' AND ($3 = ANY(events) OR '*' = ANY(events))`,
    [input.merchantId, input.mode, input.type],
  );
  for (const endpoint of rows) {
    const deliveryId = newId('whd');
    await tx.query(
      `INSERT INTO webhook_deliveries (id, event_id, endpoint_id, merchant_id, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'PENDING', now())`,
      [deliveryId, eventId, endpoint.id, input.merchantId],
    );
    await enqueue(tx, 'webhook.deliver', { deliveryId }, { dedupeKey: `wh:${deliveryId}` });
  }
  return eventId;
}

export interface DeliveryDeps {
  db: Db;
  encryptionKey: string;
  allowPrivateTargets: boolean;
  timeoutMs?: number;
}

export type DeliveryOutcome = 'delivered' | 'retrying' | 'dead' | 'skipped';

/** Sends one delivery attempt. Retries are rescheduled through the job queue with exponential backoff. */
export async function attemptDelivery(deps: DeliveryDeps, deliveryId: string): Promise<DeliveryOutcome> {
  const { rows } = await deps.db.query(
    `SELECT d.id, d.status, d.attempts, e.payload, e.type, ep.url, ep.secret_enc, ep.status AS endpoint_status
     FROM webhook_deliveries d
     JOIN webhook_events e ON e.id = d.event_id
     JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
     WHERE d.id = $1`,
    [deliveryId],
  );
  const row = rows[0];
  if (!row) return 'skipped';
  if (row.status === 'DELIVERED' || row.status === 'DEAD') return 'skipped';
  if (row.endpoint_status !== 'ACTIVE') {
    await deps.db.query("UPDATE webhook_deliveries SET status = 'DEAD', last_error = 'endpoint_disabled', updated_at = now() WHERE id = $1", [deliveryId]);
    return 'dead';
  }

  const body = JSON.stringify(row.payload);
  const secret = decryptSecret(row.secret_enc, deps.encryptionKey);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    'CardCrypto-Signature': signWebhookPayload(secret, timestamp, body),
    'CardCrypto-Event': String(row.type),
    'CardCrypto-Delivery': deliveryId,
    'user-agent': 'CardCrypto-Webhooks/1.0',
  };

  let statusCode: number | null = null;
  let error: string | null = null;
  let durationMs = 0;
  try {
    const result = await safePost(row.url, headers, body, { timeoutMs: deps.timeoutMs ?? 10_000, allowPrivate: deps.allowPrivateTargets });
    statusCode = result.status;
    durationMs = result.durationMs;
  } catch (cause) {
    error = (cause as Error).message.slice(0, 500);
  }

  const attemptNo = Number(row.attempts) + 1;
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
  await deps.db.query(
    'INSERT INTO webhook_attempts (delivery_id, attempt_no, status_code, duration_ms, error) VALUES ($1, $2, $3, $4, $5)',
    [deliveryId, attemptNo, statusCode, durationMs, error],
  );

  if (ok) {
    await deps.db.query(
      `UPDATE webhook_deliveries SET status = 'DELIVERED', attempts = $2, last_status_code = $3, last_error = NULL, delivered_at = now(), updated_at = now() WHERE id = $1`,
      [deliveryId, attemptNo, statusCode],
    );
    return 'delivered';
  }

  const lastError = error ?? `HTTP ${statusCode}`;
  if (attemptNo >= WEBHOOK_MAX_ATTEMPTS) {
    await deps.db.query(
      `UPDATE webhook_deliveries SET status = 'DEAD', attempts = $2, last_status_code = $3, last_error = $4, updated_at = now() WHERE id = $1`,
      [deliveryId, attemptNo, statusCode, lastError],
    );
    return 'dead';
  }

  const delayMs = WEBHOOK_BACKOFF_MS[attemptNo - 1] ?? WEBHOOK_BACKOFF_MS[WEBHOOK_BACKOFF_MS.length - 1] ?? 60_000;
  await withTransaction(deps.db, async (tx) => {
    await tx.query(
      `UPDATE webhook_deliveries SET status = 'RETRYING', attempts = $2, last_status_code = $3, last_error = $4,
         next_attempt_at = now() + ($5::int * interval '1 millisecond'), updated_at = now()
       WHERE id = $1`,
      [deliveryId, attemptNo, statusCode, lastError, delayMs],
    );
    await enqueue(tx, 'webhook.deliver', { deliveryId }, { delayMs, dedupeKey: `wh:${deliveryId}` });
  });
  return 'retrying';
}

/** Re-queues a finished delivery as a fresh delivery of the same event (used by the dashboard "replay"). */
export async function replayDelivery(db: Queryable, deliveryId: string, merchantId: string): Promise<string | null> {
  const { rows } = await db.query('SELECT event_id, endpoint_id FROM webhook_deliveries WHERE id = $1 AND merchant_id = $2', [deliveryId, merchantId]);
  const row = rows[0];
  if (!row) return null;
  const newDeliveryId = newId('whd');
  await db.query(
    `INSERT INTO webhook_deliveries (id, event_id, endpoint_id, merchant_id, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, 'PENDING', now())`,
    [newDeliveryId, row.event_id, row.endpoint_id, merchantId],
  );
  await enqueue(db, 'webhook.deliver', { deliveryId: newDeliveryId }, { dedupeKey: `wh:${newDeliveryId}` });
  return newDeliveryId;
}

export type { Db };
