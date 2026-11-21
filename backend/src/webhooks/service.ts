import { appendAudit } from '../audit/audit.js';
import type { AppConfig } from '../config.js';
import { AppError, err } from '../core/errors.js';
import { encryptSecret, newId, randomToken } from '../core/security.js';
import type { Mode } from '../core/types.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { AuthContext } from '../merchant/auth.js';
import { assertWritable } from '../merchant/auth.js';
import { WEBHOOK_EVENT_TYPES, replayDelivery } from './outbound.js';

export class WebhookService {
  constructor(private readonly deps: { db: Db; config: AppConfig }) {}

  async listEndpoints(merchantId: string, mode: Mode): Promise<Record<string, unknown>[]> {
    const { rows } = await this.deps.db.query(
      'SELECT id, url, events, status, mode, created_at FROM webhook_endpoints WHERE merchant_id = $1 AND mode = $2 ORDER BY created_at',
      [merchantId, mode],
    );
    return rows.map((r) => ({ id: r.id, url: r.url, events: r.events, status: r.status, mode: r.mode, created_at: r.created_at }));
  }

  async createEndpoint(ctx: AuthContext, input: { url: string; events: string[] }): Promise<Record<string, unknown>> {
    assertWritable(ctx);
    const merchantId = ctx.merchantId;
    if (!merchantId) throw err.forbidden('merchant_required', 'Merchant account required.');
    const url = this.validateUrl(input.url, ctx.mode);
    const events = this.validateEvents(input.events);

    const count = await this.deps.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM webhook_endpoints WHERE merchant_id = $1 AND mode = $2 AND status = 'ACTIVE'",
      [merchantId, ctx.mode],
    );
    if ((count.rows[0]?.n ?? 0) >= 10) throw err.conflict('endpoint_limit', 'At most 10 active webhook endpoints per mode.');

    const id = newId('whe');
    const secret = `whsec_${randomToken(24)}`;
    await withTransaction(this.deps.db, async (tx) => {
      await tx.query(
        `INSERT INTO webhook_endpoints (id, merchant_id, mode, url, events, secret_enc, status) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
        [id, merchantId, ctx.mode, url, events, encryptSecret(secret, this.deps.config.dataEncryptionKey)],
      );
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'webhook_endpoint.created',
        entityType: 'webhook_endpoint',
        entityId: id,
        data: { url, events },
        ip: ctx.ip,
      });
    });
    // The signing secret is shown once.
    return { id, url, events, mode: ctx.mode, status: 'ACTIVE', secret };
  }

  async rotateSecret(ctx: AuthContext, id: string): Promise<Record<string, unknown>> {
    assertWritable(ctx);
    const secret = `whsec_${randomToken(24)}`;
    const result = await this.deps.db.query(
      'UPDATE webhook_endpoints SET secret_enc = $3, updated_at = now() WHERE id = $1 AND merchant_id = $2 RETURNING id',
      [id, ctx.merchantId, encryptSecret(secret, this.deps.config.dataEncryptionKey)],
    );
    if (result.rowCount === 0) throw err.notFound('Webhook endpoint');
    return { id, secret };
  }

  async disableEndpoint(ctx: AuthContext, id: string): Promise<void> {
    assertWritable(ctx);
    const result = await this.deps.db.query(
      "UPDATE webhook_endpoints SET status = 'DISABLED', updated_at = now() WHERE id = $1 AND merchant_id = $2",
      [id, ctx.merchantId],
    );
    if (result.rowCount === 0) throw err.notFound('Webhook endpoint');
  }

  async listDeliveries(merchantId: string, mode: Mode, status: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
    const { rows } = await this.deps.db.query(
      `SELECT d.id, d.status, d.attempts, d.last_status_code, d.last_error, d.created_at, d.delivered_at, d.next_attempt_at,
              e.type, e.payment_id, ep.url
       FROM webhook_deliveries d
       JOIN webhook_events e ON e.id = d.event_id
       JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
       WHERE d.merchant_id = $1 AND e.mode = $2 AND ($3::text IS NULL OR d.status = $3)
       ORDER BY d.created_at DESC LIMIT $4`,
      [merchantId, mode, status ?? null, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      event: r.type,
      payment_id: r.payment_id,
      endpoint_url: r.url,
      status: r.status,
      attempts: r.attempts,
      last_status_code: r.last_status_code,
      last_error: r.last_error,
      next_attempt_at: r.status === 'DELIVERED' || r.status === 'DEAD' ? null : r.next_attempt_at,
      delivered_at: r.delivered_at,
      created_at: r.created_at,
    }));
  }

  async getDelivery(merchantId: string, id: string): Promise<Record<string, unknown>> {
    const { rows } = await this.deps.db.query(
      `SELECT d.*, e.type, e.payload FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
       WHERE d.id = $1 AND d.merchant_id = $2`,
      [id, merchantId],
    );
    const row = rows[0];
    if (!row) throw err.notFound('Webhook delivery');
    const attempts = await this.deps.db.query(
      'SELECT attempt_no, status_code, duration_ms, error, created_at FROM webhook_attempts WHERE delivery_id = $1 ORDER BY attempt_no',
      [id],
    );
    return {
      id: row.id,
      event: row.type,
      status: row.status,
      attempts: row.attempts,
      payload: row.payload,
      attempt_log: attempts.rows,
      created_at: row.created_at,
    };
  }

  async replay(ctx: AuthContext, deliveryId: string): Promise<Record<string, unknown>> {
    assertWritable(ctx);
    const merchantId = ctx.merchantId;
    if (!merchantId) throw err.forbidden('merchant_required', 'Merchant account required.');
    const newDelivery = await replayDelivery(this.deps.db, deliveryId, merchantId);
    if (!newDelivery) throw err.notFound('Webhook delivery');
    return { id: newDelivery, replay_of: deliveryId, status: 'PENDING' };
  }

  private validateUrl(raw: string, mode: Mode): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw err.unprocessable('invalid_url', 'Webhook URL is not valid.');
    }
    if (url.username || url.password) throw err.unprocessable('invalid_url', 'Webhook URL must not contain credentials.');
    const allowHttp = mode === 'test' && this.deps.config.webhookAllowPrivateTargets;
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      throw err.unprocessable('invalid_url', 'Webhook URL must use HTTPS.');
    }
    if (raw.length > 2048) throw err.unprocessable('invalid_url', 'Webhook URL is too long.');
    return url.toString();
  }

  private validateEvents(events: string[]): string[] {
    if (events.includes('*')) return ['*'];
    const allowed = new Set<string>(WEBHOOK_EVENT_TYPES);
    const unknown = events.filter((e) => !allowed.has(e));
    if (unknown.length > 0) throw new AppError(422, 'invalid_events', `Unknown event types: ${unknown.join(', ')}`);
    return [...new Set(events)];
  }
}
