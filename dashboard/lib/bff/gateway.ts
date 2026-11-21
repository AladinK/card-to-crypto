import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { BackendError, BackendUnreachableError, callBackend, toBackendError, type BackendCall } from './backend';
import { MODE_COOKIE, REFRESH_COOKIE, isValidRefreshToken, modeCookieOptions, refreshCookieOptions } from './cookies';
import { accessTokenFor, SessionExpiredError } from './session-store';

export type Mode = 'test' | 'live';

export const isMode = (value: unknown): value is Mode => value === 'test' || value === 'live';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Error body in the same shape the API uses, so the browser handles one format everywhere. */
export function errorResponse(status: number, code: string, message: string, requestId?: string, details?: unknown): NextResponse {
  return NextResponse.json(
    {
      error: {
        type: status >= 500 ? 'api_error' : 'invalid_request',
        code,
        message,
        ...(requestId ? { request_id: requestId } : {}),
        ...(details !== undefined && status < 500 ? { details } : {}),
      },
    },
    { status, headers: NO_STORE },
  );
}

export function readRefresh(req: NextRequest): string | undefined {
  const value = req.cookies.get(REFRESH_COOKIE)?.value;
  return isValidRefreshToken(value) ? value : undefined;
}

/** Turns any failure from the BFF or the API into the response the browser should see. */
export function failureResponse(error: unknown): NextResponse {
  if (error instanceof SessionExpiredError) {
    const res = errorResponse(401, 'session_expired', error.message);
    res.cookies.set(REFRESH_COOKIE, '', refreshCookieOptions(0));
    return res;
  }
  if (error instanceof BackendError) return errorResponse(error.status, error.code, error.message, error.requestId, error.details);
  if (error instanceof BackendUnreachableError) {
    return errorResponse(502, 'upstream_unavailable', 'The payments API is unreachable. Check that the backend is running.');
  }
  console.error('[dashboard-bff] unexpected failure', error instanceof Error ? error.name : 'unknown');
  return errorResponse(500, 'internal_error', 'Something went wrong.');
}

export interface MerchantCall extends Omit<BackendCall, 'token'> {
  path: string;
}

export interface MerchantResult {
  status: number;
  body: unknown;
  /** Refresh token the browser should hold now. Equal to the cookie unless the API rotated it. */
  refresh: string;
}

/**
 * Calls the API as the signed-in merchant. The access token is attached server-side. If the API rejects it,
 * the token is refreshed once and the call is retried. Other 401s (for example a wrong TOTP code) are returned.
 */
export async function callAsMerchant(refreshCookie: string, call: MerchantCall): Promise<MerchantResult> {
  const { path, ...rest } = call;
  const send = (token: string) => callBackend(path, { ...rest, token });

  let { access, refresh } = await accessTokenFor(refreshCookie);
  let res = await send(access);
  if (res.status === 401 && isRejectedAccessToken(res.body)) {
    ({ access, refresh } = await accessTokenFor(refreshCookie, access));
    res = await send(access);
  }
  if (res.status >= 400) throw toBackendError(res);
  return { status: res.status, body: res.body, refresh };
}

function isRejectedAccessToken(body: unknown): boolean {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && /access token/i.test(message);
}

/** Applies a refresh-token rotation to a response, or clears the cookie when the session is gone. */
export function withRefresh<T extends NextResponse>(res: T, previous: string, current: string): T {
  if (current !== previous) res.cookies.set(REFRESH_COOKIE, current, refreshCookieOptions());
  return res;
}

/** One-call handler for routes that proxy to the API as the merchant. */
export async function proxyAsMerchant(req: NextRequest, call: MerchantCall, mode?: Mode): Promise<NextResponse> {
  const refresh = readRefresh(req);
  if (!refresh) return errorResponse(401, 'unauthenticated', 'Sign in to continue.');
  try {
    const result = await callAsMerchant(refresh, { ...call, mode });
    const res =
      result.status === 204
        ? new NextResponse(null, { status: 204, headers: NO_STORE })
        : NextResponse.json(result.body ?? {}, { status: result.status, headers: NO_STORE });
    return withRefresh(res, refresh, result.refresh);
  } catch (error) {
    return failureResponse(error);
  }
}

export function modeFrom(req: NextRequest): Mode {
  const value = req.cookies.get(MODE_COOKIE)?.value;
  return isMode(value) ? value : 'test';
}

export function setModeCookie<T extends NextResponse>(res: T, mode: Mode): T {
  res.cookies.set(MODE_COOKIE, mode, modeCookieOptions());
  return res;
}
