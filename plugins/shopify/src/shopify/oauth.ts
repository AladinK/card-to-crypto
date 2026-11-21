import { PermanentError, TransientError } from '../errors.js';
import type { FetchFn } from '../types.js';

export const OAUTH_STATE_COOKIE = 'ccs_oauth_state';

export function buildAuthorizeUrl(input: {
  shop: string;
  apiKey: string;
  scopes: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.apiKey,
    scope: input.scopes,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://${input.shop}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Exchanges the OAuth code for an offline access token. Sends the same JSON body as
 * @shopify/shopify-api, including expiring: '0' (non-expiring offline token, the SDK default).
 */
export async function exchangeCodeForToken(
  deps: { fetch: FetchFn; timeoutMs: number },
  input: { shop: string; apiKey: string; apiSecret: string; code: string },
): Promise<{ accessToken: string; scope: string }> {
  const response = await deps.fetch(`https://${input.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: input.apiKey,
      client_secret: input.apiSecret,
      code: input.code,
      expiring: '0',
    }),
    signal: AbortSignal.timeout(deps.timeoutMs),
  });

  if (response.status === 400 || response.status === 401) {
    throw new PermanentError('token_exchange_rejected', `token exchange rejected with HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new TransientError('token_exchange_failed', `token exchange failed with HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TransientError('token_exchange_invalid_json');
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new TransientError('token_exchange_missing_token');
  }
  const scope = (body as { scope?: unknown }).scope;
  return { accessToken, scope: typeof scope === 'string' ? scope : '' };
}
