import { AppError } from '../core/errors.js';
import { canonicalJson } from '../core/types.js';
import { sha256Hex } from '../core/security.js';
import type { Db } from '../db/pool.js';

export interface StoredResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

const STALE_IN_PROGRESS_MS = 2 * 60_000;

/**
 * Idempotency-Key handling (Stripe-style):
 *  - same key + same request  -> stored response is replayed, no side effects run twice
 *  - same key + different body -> 422
 *  - concurrent duplicate      -> 409 until the first request finishes
 *  - 5xx outcomes are not stored, so the client may retry safely
 */
export async function runIdempotent(
  db: Db,
  input: { merchantId: string; key: string; scope: string; body: unknown },
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<StoredResponse> {
  const requestHash = sha256Hex(canonicalJson({ scope: input.scope, body: input.body }));

  const claim = () =>
    db.query(
      `INSERT INTO idempotency_keys (merchant_id, idem_key, request_hash, state)
       VALUES ($1, $2, $3, 'IN_PROGRESS') ON CONFLICT DO NOTHING RETURNING merchant_id`,
      [input.merchantId, input.key, requestHash],
    );

  let claimed = await claim();
  if (claimed.rowCount === 0) {
    const existing = await db.query<{
      request_hash: string;
      state: string;
      response_status: number | null;
      response_body: unknown;
      created_at: Date;
    }>('SELECT request_hash, state, response_status, response_body, created_at FROM idempotency_keys WHERE merchant_id = $1 AND idem_key = $2', [
      input.merchantId,
      input.key,
    ]);
    const row = existing.rows[0];
    if (!row) {
      claimed = await claim();
    } else {
      if (row.request_hash !== requestHash) {
        throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with different parameters.');
      }
      if (row.state === 'COMPLETED') {
        return { status: row.response_status ?? 200, body: row.response_body, replayed: true };
      }
      const age = Date.now() - new Date(row.created_at).getTime();
      if (age < STALE_IN_PROGRESS_MS) {
        throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed.');
      }
      // The previous attempt crashed mid-way: release the key and run again.
      await db.query('DELETE FROM idempotency_keys WHERE merchant_id = $1 AND idem_key = $2 AND state = $3', [
        input.merchantId,
        input.key,
        'IN_PROGRESS',
      ]);
      claimed = await claim();
    }
  }
  if (claimed.rowCount === 0) {
    throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed.');
  }

  try {
    const result = await handler();
    await db.query(
      `UPDATE idempotency_keys SET state = 'COMPLETED', response_status = $3, response_body = $4
       WHERE merchant_id = $1 AND idem_key = $2`,
      [input.merchantId, input.key, result.status, JSON.stringify(result.body ?? null)],
    );
    return { ...result, replayed: false };
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      const body = { error: { type: 'invalid_request', code: error.code, message: error.message, details: error.details } };
      await db.query(
        `UPDATE idempotency_keys SET state = 'COMPLETED', response_status = $3, response_body = $4
         WHERE merchant_id = $1 AND idem_key = $2`,
        [input.merchantId, input.key, error.status, JSON.stringify(body)],
      );
      return { status: error.status, body, replayed: false };
    }
    await db.query('DELETE FROM idempotency_keys WHERE merchant_id = $1 AND idem_key = $2', [input.merchantId, input.key]);
    throw error;
  }
}
