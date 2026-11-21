import { NextResponse, type NextRequest } from 'next/server';
import { MODE_COOKIE } from '@/lib/bff/cookies';
import { callAsMerchant, errorResponse, failureResponse, readRefresh, setModeCookie, withRefresh } from '@/lib/bff/gateway';

interface MeBody {
  user: unknown;
  merchant: { live_enabled?: unknown } | null;
}

/**
 * Who is signed in, and which mode is active. Live is only reported as active when the API says the merchant
 * has it enabled, so the UI can never show LIVE for an account that cannot use it.
 */
export async function GET(req: NextRequest) {
  const refresh = readRefresh(req);
  if (!refresh) return errorResponse(401, 'unauthenticated', 'Sign in to continue.');
  try {
    const result = await callAsMerchant(refresh, { path: '/v1/me' });
    const me = result.body as MeBody;
    const liveEnabled = me.merchant?.live_enabled === true;
    const requested = req.cookies.get(MODE_COOKIE)?.value;
    const mode = requested === 'live' && liveEnabled ? 'live' : 'test';

    let res = NextResponse.json(
      { user: me.user, merchant: me.merchant, mode, liveEnabled },
      { headers: { 'cache-control': 'no-store' } },
    );
    res = withRefresh(res, refresh, result.refresh);
    if (requested && requested !== mode) res = setModeCookie(res, mode);
    return res;
  } catch (error) {
    return failureResponse(error);
  }
}
