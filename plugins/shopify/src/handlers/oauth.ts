import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readOAuthStateCookie, safeEqualText, signOAuthState, verifyOAuthCallback } from '../crypto/hmac.js';
import { encryptToken } from '../crypto/token-crypto.js';
import { errorCode, type AppDeps } from '../deps.js';
import { cookieValue, sendHtml, sendRedirect } from '../http.js';
import { pageHtml } from '../pages.js';
import { buildAuthorizeUrl, exchangeCodeForToken, OAUTH_STATE_COOKIE } from '../shopify/oauth.js';
import { normalizeShop } from '../shopify/shop.js';

const STATE_TTL_SECONDS = 600;

function stateCookie(deps: AppDeps, value: string, maxAge: number): string {
  const secure = deps.config.appUrl.startsWith('https://') ? '; Secure' : '';
  return `${OAUTH_STATE_COOKIE}=${value}; Max-Age=${maxAge}; Path=/auth; HttpOnly; SameSite=Lax${secure}`;
}

/** GET /auth?shop=<shop>: sets a signed state cookie and redirects to Shopify's consent page. */
export function handleAuthStart(deps: AppDeps, url: URL, res: ServerResponse): void {
  const shop = normalizeShop(url.searchParams.get('shop'));
  if (!shop) {
    sendHtml(res, 400, pageHtml('Invalid shop', 'Enter a shop domain such as your-store.myshopify.com.'));
    return;
  }
  const state = randomBytes(16).toString('hex');
  const location = buildAuthorizeUrl({
    shop,
    apiKey: deps.config.shopify.apiKey,
    scopes: deps.config.shopify.scopes,
    redirectUri: `${deps.config.appUrl}/auth/callback`,
    state,
  });
  sendRedirect(res, location, {
    'set-cookie': stateCookie(deps, signOAuthState(shop, state, deps.config.cookieSecret), STATE_TTL_SECONDS),
  });
}

/** GET /auth/callback: verifies the query HMAC and the state cookie, exchanges the code, stores the encrypted token. */
export async function handleAuthCallback(deps: AppDeps, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  const clearCookie = stateCookie(deps, '', 0);
  const params = url.searchParams;

  const shop = normalizeShop(params.get('shop'));
  if (!shop) {
    sendHtml(res, 400, pageHtml('Invalid shop', 'The install request did not include a valid shop.'), {
      'set-cookie': clearCookie,
    });
    return;
  }

  const signature = verifyOAuthCallback(params, deps.config.shopify.apiSecret, deps.nowSeconds());
  if (!signature.ok) {
    deps.logger.warn('oauth callback rejected', { shop, reason: signature.reason });
    sendHtml(
      res,
      401,
      pageHtml('Install not verified', 'The request could not be verified. Start the install again from Shopify.'),
      { 'set-cookie': clearCookie },
    );
    return;
  }

  const cookieState = readOAuthStateCookie(cookieValue(req, OAUTH_STATE_COOKIE), shop, deps.config.cookieSecret);
  const queryState = params.get('state');
  if (!cookieState || !queryState || !safeEqualText(cookieState, queryState)) {
    deps.logger.warn('oauth state mismatch', { shop });
    sendHtml(res, 401, pageHtml('Install not verified', 'The install session expired. Start the install again.'), {
      'set-cookie': clearCookie,
    });
    return;
  }

  const code = params.get('code');
  if (!code || code.length > 512) {
    sendHtml(res, 400, pageHtml('Install failed', 'The install request is missing an authorization code.'), {
      'set-cookie': clearCookie,
    });
    return;
  }

  let token: { accessToken: string; scope: string };
  try {
    token = await exchangeCodeForToken(
      { fetch: deps.fetch, timeoutMs: deps.config.shopify.timeoutMs },
      {
        shop,
        apiKey: deps.config.shopify.apiKey,
        apiSecret: deps.config.shopify.apiSecret,
        code,
      },
    );
  } catch (error) {
    deps.logger.error('token exchange failed', { shop, code: errorCode(error) });
    sendHtml(res, 502, pageHtml('Install failed', 'Shopify did not issue a token. Try the install again.'), {
      'set-cookie': clearCookie,
    });
    return;
  }

  // The plaintext token exists only in this scope and is never logged.
  const encrypted = encryptToken(token.accessToken, shop, deps.config.tokenEncryptionKey);
  await deps.store.upsertShop(shop, encrypted, token.scope || deps.config.shopify.scopes);
  deps.logger.info('shop installed', { shop, scopes: token.scope });

  sendHtml(res, 200, pageHtml('App installed', 'You can close this window and return to your Shopify admin.'), {
    'set-cookie': clearCookie,
  });
}
