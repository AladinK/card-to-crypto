import { NextResponse, type NextRequest } from 'next/server';
import { assertSameOriginWrite } from '@/lib/bff/guard';
import { errorResponse, modeFrom, proxyAsMerchant } from '@/lib/bff/gateway';
import { FORWARDED_QUERY_KEYS, isAllowedRoute, type ProxyMethod } from '@/lib/bff/routes';

type Context = { params: Promise<{ path: string[] }> };

const MAX_BODY_BYTES = 16_384;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/;

export async function GET(req: NextRequest, context: Context) {
  return forward(req, await context.params, 'GET');
}

export async function POST(req: NextRequest, context: Context) {
  return forward(req, await context.params, 'POST');
}

/**
 * Forwards an allowlisted call to the API as the signed-in merchant. Writes are checked for same-origin
 * before the body is read. The body is forwarded as received after a JSON syntax check. The API validates the rest.
 */
async function forward(req: NextRequest, params: { path: string[] }, method: ProxyMethod): Promise<NextResponse> {
  const path = `/v1/${params.path.join('/')}`;
  if (!isAllowedRoute(method, path)) return errorResponse(404, 'not_found', 'Route not found.');

  if (method === 'POST') {
    const denied = assertSameOriginWrite(req);
    if (denied) return denied;
  }

  const query = new URLSearchParams();
  for (const [key, value] of req.nextUrl.searchParams) {
    if (FORWARDED_QUERY_KEYS.has(key) && value.length <= 64) query.append(key, value);
  }

  let body: string | undefined;
  if (method === 'POST') {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return errorResponse(413, 'payload_too_large', 'The request body is too large.');
    if (raw.trim()) {
      try {
        JSON.parse(raw);
      } catch {
        return errorResponse(400, 'invalid_json', 'The request body is not valid JSON.');
      }
      body = raw;
    }
  }

  const keyHeader = req.headers.get('idempotency-key');
  const idempotencyKey = keyHeader && IDEMPOTENCY_KEY.test(keyHeader) ? keyHeader : undefined;
  if (method === 'POST' && path.endsWith('/refund') && !idempotencyKey) {
    return errorResponse(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8-255 characters) with this request.');
  }

  return proxyAsMerchant(
    req,
    { path, method, query: query.toString() || undefined, body, idempotencyKey },
    modeFrom(req),
  );
}
