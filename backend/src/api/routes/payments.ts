import type { FastifyInstance } from 'fastify';
import { ASSETS, CHAINS, isAssetCode, isChainKey } from '../../core/assets.js';
import { err } from '../../core/errors.js';
import { baseUnitsToDecimal, formatFiat, parseFiatAmount } from '../../core/money.js';
import type { Container } from '../../container.js';
import { runIdempotent } from '../../idempotency/index.js';
import { authenticate, merchantFor } from '../auth.js';
import { idempotencyKeyOf, pagination, parseBody } from '../http.js';
import { paymentBody, quoteBody, refundBody } from '../schemas.js';
import { requireMerchant } from '../../merchant/service.js';

export function registerPaymentRoutes(app: FastifyInstance, c: Container): void {
  app.post('/v1/payments', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const key = idempotencyKeyOf(request);
    const body = parseBody(paymentBody, request.body);

    const result = await runIdempotent(c.db, { merchantId: merchant.id, key, scope: `${ctx.mode} POST /v1/payments`, body }, async () => {
      const payment = await c.payments.createPayment(ctx, merchant, {
        amount: body.amount,
        currency: body.currency,
        orderId: body.order_id,
        customerEmail: body.customer?.email ?? null,
        description: body.description ?? '',
        returnUrl: body.return_url,
        cancelUrl: body.cancel_url ?? body.return_url,
        metadata: body.metadata ?? {},
        storeId: body.store_id ?? null,
        settlement: body.settlement ?? {},
        idempotencyKey: key,
      });
      return { status: 201, body: payment };
    });
    return reply.code(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
  });

  app.get('/v1/payments', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const page = pagination(request);
    const status = (request.query as Record<string, string | undefined>).status;
    return reply.send(await c.payments.listPayments(merchant.id, ctx.mode, { status, limit: page.limit, startingAfter: page.startingAfter }));
  });

  app.get<{ Params: { id: string } }>('/v1/payments/:id', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    return reply.send(await c.payments.getPayment(merchant.id, ctx.mode, request.params.id));
  });

  app.get<{ Params: { id: string } }>('/v1/payments/:id/settlement', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    return reply.send(await c.payments.getSettlement(merchant.id, ctx.mode, request.params.id));
  });

  app.post<{ Params: { id: string } }>('/v1/payments/:id/refund', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const key = idempotencyKeyOf(request);
    const body = parseBody(refundBody, request.body ?? {});
    const paymentId = request.params.id;

    const result = await runIdempotent(c.db, { merchantId: merchant.id, key, scope: `${ctx.mode} refund ${paymentId}`, body }, async () => {
      const refund = await c.payments.createRefund(ctx, merchant, paymentId, {
        amount: body.amount,
        reason: body.reason,
        idempotencyKey: key,
      });
      return { status: 201, body: refund };
    });
    return reply.code(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
  });

  app.get('/v1/transactions', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const limit = pagination(request).limit;
    return reply.send({ data: await c.payments.listTransactions(merchant.id, ctx.mode, limit) });
  });

  app.post('/v1/quotes', async (request, reply) => {
    const ctx = await authenticate(c, request);
    const merchant = await merchantFor(c, ctx);
    const body = parseBody(quoteBody, request.body);
    if (!isChainKey(body.blockchain) || !isAssetCode(body.asset) || !CHAINS[body.blockchain].tokens[body.asset]) {
      throw err.unprocessable('unsupported_pair', `${body.asset} cannot be settled on ${body.blockchain}.`);
    }
    const chain = body.blockchain;
    const asset = body.asset;
    const adapter = c.chainFor(ctx.mode, chain);
    if (!adapter) throw err.unavailable('chain_unavailable', `${chain} is not available in ${ctx.mode} mode.`);

    let destination: string = adapter.treasury.address;
    if (body.wallet_id) {
      const { rows } = await c.db.query('SELECT address FROM wallets WHERE id = $1 AND merchant_id = $2', [body.wallet_id, requireMerchant(ctx)]);
      if (!rows[0]) throw err.notFound('Wallet');
      destination = String(rows[0].address);
    }

    const quote = await c.quotes.create(c.db, {
      merchantId: merchant.id,
      mode: ctx.mode,
      paymentId: null,
      fiatMinor: parseFiatAmount(body.amount),
      currency: body.currency,
      asset,
      chain,
      destination,
      feeSchedule: merchant.fee_schedule,
    });
    const decimals = ASSETS[asset].decimals;
    return reply.code(201).send({
      id: quote.id,
      object: 'quote',
      fiat_amount: formatFiat(quote.fiatMinor),
      fiat_currency: quote.currency,
      crypto_asset: asset,
      blockchain: chain,
      exchange_rate: quote.rate.toFixed(8),
      rate_source: quote.rateSource,
      crypto_amount: baseUnitsToDecimal(quote.conversion.grossCryptoBase, decimals).toFixed(),
      merchant_receives: baseUnitsToDecimal(quote.conversion.merchantNetBase, decimals).toFixed(),
      fees: {
        payment: formatFiat(quote.fees.paymentFeeMinor),
        conversion: formatFiat(quote.fees.conversionFeeMinor),
        platform: formatFiat(quote.fees.platformFeeMinor),
        network: formatFiat(quote.fees.networkFeeMinor),
        total: formatFiat(quote.fees.totalFeeMinor),
      },
      expires_at: quote.expiresAt.toISOString(),
      ttl_seconds: 30,
    });
  });

  app.get('/v1/exchange-rates', async (request, reply) => {
    const ctx = await authenticate(c, request);
    await merchantFor(c, ctx);
    const q = request.query as Record<string, string | undefined>;
    const asset = q.asset ?? 'USDC';
    const currency = q.currency ?? 'EUR';
    if (!isAssetCode(asset)) throw err.unprocessable('unsupported_asset', `Unsupported asset "${asset}".`);
    if (!['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'RSD'].includes(currency)) {
      throw err.unprocessable('unsupported_currency', `Unsupported currency "${currency}".`);
    }
    const snapshot = await c.ratesFor(ctx.mode).getRate(asset, currency as 'EUR');
    await c.db
      .query('INSERT INTO exchange_rate_snapshots (base, quote, rate, source, fetched_at) VALUES ($1, $2, $3, $4, $5)', [
        asset,
        currency,
        snapshot.rate.toFixed(18),
        snapshot.source,
        snapshot.fetchedAt,
      ])
      .catch(() => undefined);
    return reply.send({
      asset,
      fiat_currency: currency,
      rate: snapshot.rate.toFixed(8),
      meaning: `1 ${asset} = ${snapshot.rate.toFixed(8)} ${currency}`,
      source: snapshot.source,
      as_of: snapshot.fetchedAt.toISOString(),
    });
  });
}
