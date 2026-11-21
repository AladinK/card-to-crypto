import { NextResponse, type NextRequest } from 'next/server';
import { callBackend } from '@/lib/bff/backend';
import { MODE_COOKIE, REFRESH_COOKIE, modeCookieOptions, refreshCookieOptions } from '@/lib/bff/cookies';
import { readRefresh } from '@/lib/bff/gateway';
import { assertSameOriginWrite } from '@/lib/bff/guard';
import { forgetSession } from '@/lib/bff/session-store';

/** Revokes the session family at the API (best effort) and clears the browser cookies. */
export async function POST(req: NextRequest) {
  const denied = assertSameOriginWrite(req);
  if (denied) return denied;

  const refresh = readRefresh(req);
  if (refresh) {
    forgetSession(refresh);
    await callBackend('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: refresh }) }).catch(() => undefined);
  }
  const res = new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  res.cookies.set(REFRESH_COOKIE, '', refreshCookieOptions(0));
  res.cookies.set(MODE_COOKIE, '', modeCookieOptions(0));
  return res;
}
