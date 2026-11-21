import type { FastifyRequest } from 'fastify';
import { err } from '../core/errors.js';
import type { Mode } from '../core/types.js';
import type { AuthContext } from '../merchant/auth.js';
import { verifyAccessToken } from '../merchant/auth.js';
import { loadMerchant, requireMerchant, type MerchantRecord } from '../merchant/service.js';
import type { Container } from '../container.js';

function requestedMode(request: FastifyRequest): Mode | null {
  const header = request.headers['x-mode'];
  const query = (request.query as Record<string, unknown> | undefined)?.mode;
  const raw = typeof header === 'string' ? header : typeof query === 'string' ? query : null;
  if (raw === null) return null;
  if (raw !== 'test' && raw !== 'live') throw err.badRequest('invalid_mode', 'Mode must be "test" or "live".');
  return raw;
}

/**
 * Resolves the caller from `Authorization: Bearer …`.
 *  - `sk_test_…` / `sk_live_…`  -> merchant API key (service account; the key fixes the mode)
 *  - anything else              -> dashboard JWT (mode chosen per request with X-Mode or ?mode=)
 */
export async function authenticate(c: Container, request: FastifyRequest): Promise<AuthContext> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw err.unauthorized();
  const token = header.slice('Bearer '.length).trim();
  const ip = request.ip ?? null;
  const wanted = requestedMode(request);

  if (token.startsWith('sk_')) {
    const ctx = await c.merchants.authenticateApiKey(token, ip);
    if (!ctx) throw err.unauthorized('Invalid API key.');
    if (wanted && wanted !== ctx.mode) {
      throw err.badRequest('mode_mismatch', `This key operates in ${ctx.mode} mode.`);
    }
    return ctx;
  }

  const claims = await verifyAccessToken(c.config.jwtSecret, token);
  if (!claims) throw err.unauthorized('Invalid or expired access token.');
  const mode: Mode = wanted ?? 'test';
  if (mode === 'live' && claims.mid) {
    const merchant = await loadMerchant(c.db, claims.mid);
    if (!merchant.live_enabled) throw err.forbidden('live_mode_not_enabled', 'Live mode is not enabled for this account.');
  }
  return {
    kind: 'user',
    merchantId: claims.mid,
    mode,
    role: claims.mid ? claims.role : 'owner',
    userId: claims.sub,
    mfa: claims.mfa,
    apiKeyId: null,
    platformAdmin: claims.pa,
    ip,
  };
}

export function requirePlatformAdmin(ctx: AuthContext): void {
  if (!ctx.platformAdmin) throw err.forbidden('forbidden', 'Platform administrator access required.');
}

export async function merchantFor(c: Container, ctx: AuthContext): Promise<MerchantRecord> {
  return loadMerchant(c.db, requireMerchant(ctx));
}
