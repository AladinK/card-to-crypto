import type { Tx, Queryable } from '../db/pool.js';
import { canonicalJson } from '../core/types.js';
import { sha256Hex } from '../core/security.js';

export interface AuditEntry {
  actorType: 'user' | 'api_key' | 'system' | 'provider' | 'admin';
  actorId?: string | null;
  merchantId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
}

const GENESIS = 'GENESIS';

/**
 * Appends to the hash-chained audit log. Each row's hash covers the previous hash, so any
 * tampering or deletion is detectable by verifyAuditChain(). Must run inside a transaction.
 */
export async function appendAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['audit_chain']);
  const previous = await tx.query<{ hash: string }>('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
  const prevHash = previous.rows[0]?.hash ?? GENESIS;
  const createdAt = new Date().toISOString();
  const hash = sha256Hex(
    canonicalJson({
      prevHash,
      createdAt,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      merchantId: entry.merchantId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      data: entry.data ?? {},
      ip: entry.ip ?? null,
    }),
  );
  await tx.query(
    `INSERT INTO audit_logs (actor_type, actor_id, merchant_id, action, entity_type, entity_id, data, ip, prev_hash, hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.actorType,
      entry.actorId ?? null,
      entry.merchantId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      JSON.stringify(entry.data ?? {}),
      entry.ip ?? null,
      prevHash === GENESIS ? null : prevHash,
      hash,
      createdAt,
    ],
  );
}

/** Recomputes the chain from the first row. Returns the id of the first broken row, or null if intact. */
export async function verifyAuditChain(db: Queryable): Promise<{ ok: boolean; brokenAt: number | null; rows: number }> {
  const { rows } = await db.query<{
    id: string;
    prev_hash: string | null;
    hash: string;
    actor_type: string;
    actor_id: string | null;
    merchant_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    data: Record<string, unknown>;
    ip: string | null;
    created_at: Date;
  }>('SELECT * FROM audit_logs ORDER BY id ASC');
  let expectedPrev: string | null = null;
  for (const row of rows) {
    const recomputed = sha256Hex(
      canonicalJson({
        prevHash: row.prev_hash ?? GENESIS,
        createdAt: new Date(row.created_at).toISOString(),
        actorType: row.actor_type,
        actorId: row.actor_id,
        merchantId: row.merchant_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        data: row.data,
        ip: row.ip,
      }),
    );
    if (row.prev_hash !== expectedPrev || recomputed !== row.hash) {
      return { ok: false, brokenAt: Number(row.id), rows: rows.length };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, brokenAt: null, rows: rows.length };
}
