import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SANDBOX_TEST_CARDS } from '../../payment-processors/sandbox.js';
import type { Container } from '../../container.js';
import { formatFiat } from '../../core/money.js';

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#111}
.card{max-width:420px;margin:24px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.badge{display:inline-block;background:#fff4d6;color:#7a5600;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
h1{font-size:20px;margin:8px 0 16px}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;font-size:14px}
button{width:100%;padding:12px;margin-top:8px;border-radius:8px;border:1px solid #d0d4dc;background:#fff;cursor:pointer;font-size:14px;text-align:left}
button.primary{background:#111;color:#fff;border-color:#111}
small{color:#666}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export function registerCheckoutRoutes(app: FastifyInstance, c: Container): void {
  const loadSandbox = async (id: string) => {
    const { rows } = await c.db.query(
      `SELECT p.*, m.name AS merchant_name, o.external_order_id
       FROM payments p JOIN merchants m ON m.id = p.merchant_id JOIN orders o ON o.id = p.order_id
       WHERE p.id = $1 AND p.mode = 'test'`,
      [id],
    );
    return rows[0] ?? null;
  };

  /** Sandbox hosted checkout: pick a test card outcome. Only exists for test-mode payments. */
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/checkout/sandbox/:id', async (request, reply) => {
    reply.header('content-security-policy', CSP).header('cache-control', 'no-store');
    const { id } = request.params;
    const payment = await loadSandbox(id);
    if (!payment || !c.sandboxProvider.verifyCheckoutToken(id, request.query.t)) {
      return reply.code(404).type('text/html').send(layout('Not found', '<h1>Checkout not found</h1>'));
    }
    const amount = formatFiat(BigInt(String(payment.amount_minor)));
    const header = `<span class="badge">SANDBOX · no real money</span><h1>${esc(payment.merchant_name)}</h1>
      <div class="row"><span>Order</span><span>${esc(payment.external_order_id)}</span></div>
      <div class="row"><span>Amount</span><span>${esc(amount)} ${esc(payment.currency)}</span></div>
      <div class="row"><span>Settled in</span><span>${esc(payment.settlement_asset)} on ${esc(payment.settlement_blockchain)}</span></div>`;

    if (payment.status !== 'CREATED' && payment.status !== 'PAYMENT_PENDING') {
      return reply.type('text/html').send(layout('Payment', `${header}<p>This payment is already ${esc(payment.status)}.</p>`));
    }

    const buttons = SANDBOX_TEST_CARDS.map(
      (card) =>
        `<button class="${card.outcome === 'success' ? 'primary' : ''}" name="outcome" value="${card.outcome === 'success' ? 'success' : 'decline'}">
           Pay with ${esc(card.number)} <small>(${esc(card.description)})</small></button>`,
    ).join('');
    const form = `<form method="post" action="/checkout/sandbox/${esc(id)}">
      <input type="hidden" name="t" value="${esc(request.query.t)}">
      ${buttons}
      <button name="outcome" value="cancel">Cancel and return to merchant</button>
    </form>`;
    return reply.type('text/html').send(layout('Checkout', `${header}${form}`));
  });

  app.post<{ Params: { id: string } }>('/checkout/sandbox/:id', async (request, reply) => {
    reply.header('content-security-policy', CSP).header('cache-control', 'no-store');
    const { id } = request.params;
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const payment = await loadSandbox(id);
    if (!payment || !c.sandboxProvider.verifyCheckoutToken(id, body.t)) {
      return reply.code(404).type('text/html').send(layout('Not found', '<h1>Checkout not found</h1>'));
    }
    const amountMinor = BigInt(String(payment.amount_minor));
    const currency = String(payment.currency) as 'EUR';
    const base = {
      paymentId: id,
      providerSessionId: payment.provider_session_id as string | null,
      providerPaymentId: `sandbox_pi_${id}`,
      cardCountry: 'RS',
      paymentMethod: 'sandbox_card',
    };
    const outcome = body.outcome;
    if (outcome === 'success') {
      await c.payments.ingest('sandbox', [
        { kind: 'payment.authorized', eventId: `sandbox-auth:${id}`, ...base, amountMinor, currency, reason: null },
      ]);
    } else if (outcome === 'decline') {
      await c.payments.ingest('sandbox', [
        { kind: 'payment.failed', eventId: `sandbox-decline:${id}:${randomUUID()}`, ...base, amountMinor: null, currency: null, reason: 'card_declined' },
      ]);
    } else if (outcome === 'cancel') {
      await c.payments.ingest('sandbox', [
        { kind: 'payment.cancelled', eventId: `sandbox-cancel:${id}:${randomUUID()}`, ...base, amountMinor: null, currency: null, reason: 'customer_cancelled' },
      ]);
    } else {
      return reply.code(422).type('text/html').send(layout('Error', '<h1>Unknown outcome</h1>'));
    }
    return reply.code(303).header('location', `/checkout/return/${id}?outcome=${outcome === 'success' ? 'success' : 'cancelled'}`).send();
  });

  /** Return bridge: sends the customer back to the merchant. The merchant must confirm status via the API or webhooks. */
  app.get<{ Params: { id: string }; Querystring: { outcome?: string } }>('/checkout/return/:id', async (request, reply) => {
    const { rows } = await c.db.query(
      `SELECT p.id, p.status, p.return_url, p.cancel_url, o.external_order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
      [request.params.id],
    );
    const row = rows[0];
    if (!row) return reply.code(404).type('text/html').send(layout('Not found', '<h1>Payment not found</h1>'));
    const target = new URL(request.query.outcome === 'success' ? String(row.return_url) : String(row.cancel_url));
    target.searchParams.set('payment_id', String(row.id));
    target.searchParams.set('order_id', String(row.external_order_id));
    target.searchParams.set('status', String(row.status));
    return reply.code(302).header('location', target.toString()).send();
  });
}
