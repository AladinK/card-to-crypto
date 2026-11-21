import { NextResponse, type NextRequest } from 'next/server';
import { callBackend, readTokens, toBackendError } from '@/lib/bff/backend';
import { REFRESH_COOKIE, refreshCookieOptions } from '@/lib/bff/cookies';
import { errorResponse, failureResponse } from '@/lib/bff/gateway';
import { assertSameOriginWrite, readJsonObject } from '@/lib/bff/guard';
import { rememberSession } from '@/lib/bff/session-store';

/** Creates a merchant and its owner account, then signs the owner in. */
export async function POST(req: NextRequest) {
  const denied = assertSameOriginWrite(req);
  if (denied) return denied;

  const body = await readJsonObject(req);
  if (!body) return errorResponse(400, 'invalid_request', 'Send the registration details as JSON.');
  const merchantName = typeof body.merchant_name === 'string' ? body.merchant_name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';

  if (!merchantName || merchantName.length > 120) return errorResponse(422, 'invalid_request', 'Enter your business name (up to 120 characters).');
  if (!email || email.length > 254) return errorResponse(422, 'invalid_request', 'Enter a valid email address.');
  if (password.length < 12 || password.length > 200) return errorResponse(422, 'invalid_request', 'Password must be at least 12 characters.');
  if (country && !/^[A-Z]{2}$/.test(country)) return errorResponse(422, 'invalid_request', 'Country must be a 2-letter code, such as RS.');

  try {
    const res = await callBackend('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        merchant_name: merchantName,
        email,
        password,
        ...(country ? { country } : {}),
      }),
    });
    if (res.status >= 400) throw toBackendError(res);
    const tokens = readTokens(res);
    rememberSession(tokens);
    const merchantId = (res.body as { merchant_id?: unknown } | null)?.merchant_id;
    const out = NextResponse.json(
      { ok: true, merchant_id: typeof merchantId === 'string' ? merchantId : null },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
    out.cookies.set(REFRESH_COOKIE, tokens.refresh_token, refreshCookieOptions());
    return out;
  } catch (error) {
    return failureResponse(error);
  }
}
