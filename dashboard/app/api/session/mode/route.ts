import { NextResponse, type NextRequest } from 'next/server';
import { assertSameOriginWrite, readJsonObject } from '@/lib/bff/guard';
import { callAsMerchant, errorResponse, failureResponse, isMode, readRefresh, setModeCookie, withRefresh } from '@/lib/bff/gateway';

/** Switches between test and live. Live is refused unless the merchant has it enabled. */
export async function POST(req: NextRequest) {
  const denied = assertSameOriginWrite(req);
  if (denied) return denied;

  const body = await readJsonObject(req);
  const mode = body?.mode;
  if (!isMode(mode)) return errorResponse(422, 'invalid_mode', 'Mode must be "test" or "live".');
  const refresh = readRefresh(req);
  if (!refresh) return errorResponse(401, 'unauthenticated', 'Sign in to continue.');

  try {
    if (mode === 'test') {
      return setModeCookie(NextResponse.json({ mode }, { headers: { 'cache-control': 'no-store' } }), mode);
    }
    const result = await callAsMerchant(refresh, { path: '/v1/me' });
    const liveEnabled = (result.body as { merchant?: { live_enabled?: unknown } | null }).merchant?.live_enabled === true;
    if (!liveEnabled) return errorResponse(403, 'live_mode_not_enabled', 'Live mode is not enabled for this account yet.');
    const res = NextResponse.json({ mode }, { headers: { 'cache-control': 'no-store' } });
    return setModeCookie(withRefresh(res, refresh, result.refresh), mode);
  } catch (error) {
    return failureResponse(error);
  }
}
