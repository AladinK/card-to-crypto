import type { FastifyInstance } from 'fastify';
import { appendAudit, verifyAuditChain } from '../../audit/audit.js';
import type { Container } from '../../container.js';
import { err } from '../../core/errors.js';
import { replayDelivery } from '../../webhooks/outbound.js';
import { authenticate, requirePlatformAdmin } from '../auth.js';
import { parseBody, pagination } from '../http.js';
import { adminFeesBody, adminFlagBody, adminKybBody, adminStatusBody } from '../schemas.js';

/** Platform operator endpoints. Every mutating call writes to the hash-chained audit log. */
export function registerAdminRoutes(app: FastifyInstance, c: Container): void {
  const guard = async (request: Parameters<typeof authenticate>[1]) => {
    const ctx = await authenticate(c, request);
    requirePlatformAdmin(ctx);
    return ctx;
  };
  const actor = (ctx: { userId: string | null }) => ctx.userId ?? 'platform_admin';

  app.get('/v1/admin/merchants', async (request, reply) => {
    await guard(request);
    const { rows } = await c.db.query(
      'SELECT id, name, country, status, kyb_status, live_enabled, fee_schedule, created_at FROM merchants ORDER BY created_at DESC LIMIT $1',
      [pagination(request).limit],
    );
    return reply.send({ data: rows });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/merchants/:id/status', async (request, reply) => {
    const ctx = await guard(request);
    const body = parseBody(adminStatusBody, request.body);
    const result = await c.db.query('UPDATE merchants SET status = $2, updated_at = now() WHERE id = $1', [request.params.id, body.status]);
    if (result.rowCount === 0) throw err.notFound('Merchant');
    await withAudit(c, actor(ctx), request.params.id, 'merchant.status_changed', { status: body.status });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/admin/merchants/:id/kyb', async (request, reply) => {
    const ctx = await guard(request);
    const body = parseBody(adminKybBody, request.body);
    const result = await c.db.query(
      'UPDATE merchants SET kyb_status = $2, live_enabled = COALESCE($3, live_enabled), updated_at = now() WHERE id = $1',
      [request.params.id, body.status, body.live_enabled ?? null],
    );
    if (result.rowCount === 0) throw err.notFound('Merchant');
    await withAudit(c, actor(ctx), request.params.id, 'merchant.kyb_decided', { status: body.status, live_enabled: body.live_enabled ?? null });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/admin/merchants/:id/settings', async (request, reply) => {
    const ctx = await guard(request);
    const body = parseBody(adminFeesBody, request.body);
    const result = await c.db.query(
      `UPDATE merchants SET fee_schedule = CASE WHEN $2::boolean THEN $3::jsonb ELSE fee_schedule END,
         max_rate_deviation_bps = COALESCE($4, max_rate_deviation_bps),
         settlement_review_threshold_minor = COALESCE($5, settlement_review_threshold_minor), updated_at = now()
       WHERE id = $1`,
      [
        request.params.id,
        body.fee_schedule !== undefined,
        body.fee_schedule ? JSON.stringify({ ...body.fee_schedule, paymentFeeFixedMinor: String(body.fee_schedule.paymentFeeFixedMinor) }) : null,
        body.max_rate_deviation_bps ?? null,
        body.settlement_review_threshold_minor ?? null,
      ],
    );
    if (result.rowCount === 0) throw err.notFound('Merchant');
    await withAudit(c, actor(ctx), request.params.id, 'merchant.settings_changed', body as Record<string, unknown>);
    return reply.code(204).send();
  });

  /** Feature flags: e.g. key "chain:polygon" with value {"disabled": true} stops new settlements on that chain. */
  app.post('/v1/admin/flags', async (request, reply) => {
    const ctx = await guard(request);
    const body = parseBody(adminFlagBody, request.body);
    await c.db.query(
      `INSERT INTO platform_flags (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [body.key, JSON.stringify(body.value), actor(ctx)],
    );
    await withAudit(c, actor(ctx), null, 'platform.flag_set', { key: body.key, value: body.value });
    return reply.code(204).send();
  });

  app.get('/v1/admin/payments', async (request, reply) => {
    await guard(request);
    const q = request.query as Record<string, string | undefined>;
    const { rows } = await c.db.query(
      `SELECT p.id, p.merchant_id, p.mode, p.status, p.amount_minor, p.currency, p.hold_reason, p.risk_level, p.created_at
       FROM payments p WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.hold_reason IS NOT NULL)
       ORDER BY p.created_at DESC LIMIT $3`,
      [q.status ?? null, q.held === 'true' ? 'held' : null, pagination(request).limit],
    );
    return reply.send({ data: rows });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/payments/:id/release', async (request, reply) => {
    const ctx = await guard(request);
    await c.payments.releaseCaptureHold(request.params.id, actor(ctx));
    return reply.code(202).send({ id: request.params.id, action: 'capture_queued' });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/payments/:id/reject', async (request, reply) => {
    const ctx = await guard(request);
    await c.payments.rejectHeldPayment(request.params.id, actor(ctx));
    return reply.code(202).send({ id: request.params.id, action: 'authorization_release_queued' });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/settlements/:id/release', async (request, reply) => {
    const ctx = await guard(request);
    await c.settlements.release(request.params.id, actor(ctx));
    return reply.code(202).send({ payment_id: request.params.id, action: 'settlement_resumed' });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/settlements/:id/retry', async (request, reply) => {
    const ctx = await guard(request);
    await c.settlements.retry(request.params.id, actor(ctx));
    return reply.code(202).send({ payment_id: request.params.id, action: 'settlement_retry_queued' });
  });

  app.get('/v1/admin/webhook-deliveries', async (request, reply) => {
    await guard(request);
    const status = (request.query as Record<string, string | undefined>).status ?? 'DEAD';
    const { rows } = await c.db.query(
      `SELECT d.id, d.merchant_id, d.status, d.attempts, d.last_error, d.last_status_code, d.created_at, e.type
       FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
       WHERE d.status = $1 ORDER BY d.created_at DESC LIMIT $2`,
      [status, pagination(request).limit],
    );
    return reply.send({ data: rows });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/webhook-deliveries/:id/retry', async (request, reply) => {
    const ctx = await guard(request);
    const { rows } = await c.db.query('SELECT merchant_id FROM webhook_deliveries WHERE id = $1', [request.params.id]);
    if (!rows[0]) throw err.notFound('Webhook delivery');
    const newId = await replayDelivery(c.db, request.params.id, String(rows[0].merchant_id));
    await withAudit(c, actor(ctx), String(rows[0].merchant_id), 'webhook.retry_requested', { delivery_id: request.params.id });
    return reply.code(202).send({ id: newId, replay_of: request.params.id });
  });

  app.get('/v1/admin/audit-logs', async (request, reply) => {
    await guard(request);
    const q = request.query as Record<string, string | undefined>;
    const { rows } = await c.db.query(
      `SELECT id, actor_type, actor_id, merchant_id, action, entity_type, entity_id, data, ip, hash, created_at
       FROM audit_logs WHERE ($1::text IS NULL OR merchant_id = $1) ORDER BY id DESC LIMIT $2`,
      [q.merchant_id ?? null, pagination(request).limit],
    );
    return reply.send({ data: rows });
  });

  app.get('/v1/admin/audit-logs/verify', async (request, reply) => {
    await guard(request);
    return reply.send(await verifyAuditChain(c.db));
  });

  app.get('/v1/admin/jobs', async (request, reply) => {
    await guard(request);
    const status = (request.query as Record<string, string | undefined>).status ?? 'dead';
    const { rows } = await c.db.query(
      'SELECT id, queue, status, attempts, max_attempts, last_error, run_at, updated_at FROM jobs WHERE status = $1 ORDER BY updated_at DESC LIMIT $2',
      [status, pagination(request).limit],
    );
    return reply.send({ data: rows });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/jobs/:id/requeue', async (request, reply) => {
    await guard(request);
    const result = await c.db.query(
      "UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL, updated_at = now() WHERE id = $1 AND status = 'dead'",
      [request.params.id],
    );
    if (result.rowCount === 0) throw err.notFound('Dead job');
    return reply.code(202).send({ id: request.params.id, status: 'queued' });
  });

  app.get('/v1/admin/health', async (request, reply) => {
    await guard(request);
    const jobs = await c.db.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM jobs GROUP BY status');
    const deliveries = await c.db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'DEAD'");
    const held = await c.db.query<{ n: number }>("SELECT count(*)::int AS n FROM settlements WHERE hold");
    return reply.send({
      jobs: Object.fromEntries(jobs.rows.map((r) => [r.status, r.n])),
      dead_webhook_deliveries: deliveries.rows[0]?.n ?? 0,
      settlements_on_hold: held.rows[0]?.n ?? 0,
      live_configured: c.liveConfigured,
    });
  });
}

async function withAudit(c: Container, actorId: string, merchantId: string | null, action: string, data: Record<string, unknown>): Promise<void> {
  const client = await c.db.connect();
  try {
    await client.query('BEGIN');
    await appendAudit(client, { actorType: 'admin', actorId, merchantId, action, entityType: 'admin_action', entityId: null, data });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
