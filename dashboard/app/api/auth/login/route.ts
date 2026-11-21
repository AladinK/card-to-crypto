import { NextResponse, type NextRequest } from 'next/server';
import { callBackend, readTokens, toBackendError } from '@/lib/bff/backend';
import { REFRESH_COOKIE, refreshCookieOptions } from '@/lib/bff/cookies';
import { errorResponse, failureResponse } from '@/lib/bff/gateway';
import { assertSameOriginWrite, readJsonObject } from '@/lib/bff/guard';
import { rememberSession } from '@/lib/bff/session-store';

/** Signs in. The refresh token goes into an httpOnly cookie; the access token stays on the server. */
export async function POST(req: NextRequest) {
  const denied = assertSameOriginWrite(req);
  if (denied) return denied;

  const body = await readJsonObject(req);
  if (!body) return errorResponse(400, 'invalid_request', 'Send the sign-in details as JSON.');
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const totp = typeof body.totp_code === 'string' ? body.totp_code.trim() : '';
  if (!email || !password) return errorResponse(422, 'invalid_request', 'Enter your email and password.');
  if (totp && !/^\d{6}$/.test(totp)) {
    return errorResponse(422, 'invalid_request', 'Enter the 6-digit code from your authenticator app.');
  }

  try {
    const res = await callBackend('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...(totp ? { totp_code: totp } : {}) }),
    });
    if (res.status >= 400) throw toBackendError(res);
    const tokens = readTokens(res);
    rememberSession(tokens);
    const mfa = (res.body as { mfa?: unknown } | null)?.mfa === true;
    const out = NextResponse.json({ ok: true, mfa }, { headers: { 'cache-control': 'no-store' } });
    out.cookies.set(REFRESH_COOKIE, tokens.refresh_token, refreshCookieOptions());
    return out;
  } catch (error) {
    return failureResponse(error);
  }
}
