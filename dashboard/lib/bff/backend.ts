import 'server-only';

/**
 * Server-only client for the card-to-crypto API. Nothing in this module reaches the browser.
 * Logs never include request bodies, Authorization headers or token values.
 */

export const DEFAULT_API_BASE_URL = 'http://localhost:3000';

export function apiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL ?? '').trim() || DEFAULT_API_BASE_URL;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API_BASE_URL must start with http:// or https://');
  }
  return raw.replace(/\/+$/, '');
}

export interface BackendResponse {
  status: number;
  body: unknown;
}

export interface BackendCall {
  method?: 'GET' | 'POST';
  token?: string;
  mode?: 'test' | 'live';
  query?: string;
  body?: string;
  idempotencyKey?: string;
}

/** The API answered with an error. `message` is the API's own, safe-to-show text. */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export class BackendUnreachableError extends Error {
  constructor() {
    super('The payments API is unreachable.');
    this.name = 'BackendUnreachableError';
  }
}

export interface TokenPayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function callBackend(path: string, call: BackendCall = {}): Promise<BackendResponse> {
  const headers = new Headers({ accept: 'application/json' });
  if (call.token) headers.set('authorization', `Bearer ${call.token}`);
  if (call.mode) headers.set('x-mode', call.mode);
  if (call.body !== undefined) headers.set('content-type', 'application/json');
  if (call.idempotencyKey) headers.set('idempotency-key', call.idempotencyKey);

  const url = `${apiBaseUrl()}${path}${call.query ? `?${call.query}` : ''}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: call.method ?? 'GET',
      headers,
      body: call.body,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BackendUnreachableError();
  }
  return { status: response.status, body: parseJson(await response.text()) };
}

interface ApiErrorBody {
  error?: { code?: unknown; message?: unknown; request_id?: unknown; details?: unknown };
}

/** Maps a failed API response to a BackendError. Generic text is used when the API gave none. */
export function toBackendError(res: BackendResponse): BackendError {
  const err = (res.body as ApiErrorBody | null)?.error;
  const requestId = typeof err?.request_id === 'string' ? err.request_id : undefined;
  if (res.status === 429) {
    return new BackendError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.', requestId);
  }
  const message = typeof err?.message === 'string' ? err.message : '';
  if (res.status >= 500) {
    return new BackendError(502, 'upstream_error', message || 'The payments API failed to process the request. Try again.', requestId);
  }
  const code = typeof err?.code === 'string' ? err.code : 'request_failed';
  return new BackendError(res.status, code, message || 'The request failed.', requestId, err?.details);
}

export function readTokens(res: BackendResponse): TokenPayload {
  if (res.status < 200 || res.status >= 300) throw toBackendError(res);
  const body = res.body as Partial<TokenPayload> | null;
  if (
    !body ||
    typeof body.access_token !== 'string' ||
    typeof body.refresh_token !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    throw new BackendError(502, 'upstream_error', 'Unexpected response from the payments API.');
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in };
}
