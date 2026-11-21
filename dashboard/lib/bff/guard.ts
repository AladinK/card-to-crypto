import 'server-only';

import type { NextRequest } from 'next/server';
import { errorResponse } from './gateway';

/**
 * CSRF defence for state-changing BFF routes. SameSite=Lax already keeps the refresh cookie off cross-site
 * POSTs. The custom header forces a CORS preflight that this app never grants, and the Origin and
 * Sec-Fetch-Site checks are a second layer.
 */
export function assertSameOriginWrite(req: NextRequest) {
  if (req.headers.get('x-dashboard-request') !== '1') {
    return errorResponse(403, 'csrf_check_failed', 'This request must come from the dashboard.');
  }
  const origin = req.headers.get('origin');
  if (origin && origin !== req.nextUrl.origin) {
    return errorResponse(403, 'csrf_check_failed', 'Cross-origin requests are not allowed.');
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return errorResponse(403, 'csrf_check_failed', 'Cross-site requests are not allowed.');
  }
  return null;
}

/** Reads a JSON object body with a size cap. Returns null when the body is missing, oversized or not an object. */
export async function readJsonObject(req: NextRequest, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
