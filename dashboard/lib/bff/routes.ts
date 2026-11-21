import 'server-only';

/**
 * Allowlist of API endpoints the browser may reach through /api/v1. Anything not listed is a 404 here,
 * including the operator and provider-webhook routes.
 */
export type ProxyMethod = 'GET' | 'POST';

const ID = '[A-Za-z0-9_-]{1,120}';

const ROUTES: ReadonlyArray<readonly [ProxyMethod, string]> = [
  ['GET', '/v1/me'],
  ['GET', '/v1/analytics/summary'],
  ['GET', '/v1/transactions'],
  ['GET', '/v1/payments'],
  ['GET', '/v1/payments/:id'],
  ['GET', '/v1/payments/:id/settlement'],
  ['POST', '/v1/payments/:id/refund'],
  ['GET', '/v1/wallet'],
  ['POST', '/v1/wallet'],
  ['POST', '/v1/wallet/:id/verify'],
  ['POST', '/v1/wallet/:id/default'],
  ['POST', '/v1/wallet/:id/disable'],
  ['GET', '/v1/api-keys'],
  ['POST', '/v1/api-keys'],
  ['POST', '/v1/api-keys/:id/rotate'],
  ['POST', '/v1/api-keys/:id/revoke'],
  ['GET', '/v1/webhook-endpoints'],
  ['POST', '/v1/webhook-endpoints'],
  ['POST', '/v1/webhook-endpoints/:id/rotate-secret'],
  ['POST', '/v1/webhook-endpoints/:id/disable'],
  ['GET', '/v1/webhook-deliveries'],
  ['GET', '/v1/webhook-deliveries/:id'],
  ['POST', '/v1/webhook-deliveries/:id/replay'],
  ['POST', '/v1/auth/mfa/setup'],
  ['POST', '/v1/auth/mfa/enable'],
];

const COMPILED = ROUTES.map(([method, template]) => ({
  method,
  pattern: new RegExp(`^${template.replace(':id', ID)}$`),
}));

export function isAllowedRoute(method: ProxyMethod, path: string): boolean {
  return COMPILED.some((route) => route.method === method && route.pattern.test(path));
}

/** Query parameters the dashboard uses. Everything else is dropped. */
export const FORWARDED_QUERY_KEYS: ReadonlySet<string> = new Set(['from', 'to', 'limit', 'status', 'starting_after']);
