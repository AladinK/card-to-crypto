import { SESSION_EXPIRED_EVENT } from '../constants';

/** Failure from the BFF. `message` is safe to display. `code` is the API's stable identifier. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; request_id?: unknown; details?: unknown };
}

/** Message for a toast or inline notice. Validation issues from the API are appended when present. */
export function messageOf(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!(error instanceof ApiError)) return fallback;
  const details = error.details as { issues?: Array<{ message?: unknown }> } | undefined;
  const issues = Array.isArray(details?.issues)
    ? details.issues.map((issue) => (typeof issue.message === 'string' ? issue.message : '')).filter(Boolean)
    : [];
  return issues.length > 0 ? `${error.message} ${issues.join(' ')}` : error.message;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Calls the dashboard BFF (same origin). Writes carry the CSRF header the BFF requires. */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-dashboard-request'] = '1';
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError('Could not reach the dashboard server. Check your connection and try again.', 0, 'network_error');
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const error = (json as ErrorBody | null)?.error;
    const code = typeof error?.code === 'string' ? error.code : 'request_failed';
    if (code === 'session_expired' || code === 'unauthenticated') {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(
      typeof error?.message === 'string' ? error.message : 'The request failed. Try again.',
      response.status,
      code,
      typeof error?.request_id === 'string' ? error.request_id : undefined,
      error?.details,
    );
  }
  return json as T;
}

export const newIdempotencyKey = (): string => crypto.randomUUID();
