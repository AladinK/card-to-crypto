import 'server-only';

import { createHash } from 'node:crypto';
import { callBackend, readTokens, type TokenPayload } from './backend';

/**
 * Access tokens live only in this server process, keyed by the SHA-256 of the refresh token the browser
 * holds. The browser keeps just the refresh token (httpOnly cookie) and never receives an access token.
 *
 * The API rotates refresh tokens on every use and treats reuse of an old one as theft (it revokes the whole
 * family). So refreshes are single-flighted per token, and a stale cookie is followed to its successor for a
 * short window. Without that, two parallel dashboard requests could burn the same refresh token.
 */

const ACCESS_SKEW_MS = 30_000;
const SUCCESSOR_TTL_MS = 120_000;
const IDLE_TTL_MS = 60 * 60_000;

interface Entry {
  access: string;
  expiresAt: number;
  refresh: string;
  lastUsed: number;
}

const entries = new Map<string, Entry>();
const successors = new Map<string, { refresh: string; expires: number }>();
const inflight = new Map<string, Promise<Entry>>();
let lastSweep = 0;

/** The refresh token is no longer valid: the user must sign in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session has expired. Sign in again.');
    this.name = 'SessionExpiredError';
  }
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of entries) if (now - entry.lastUsed > IDLE_TTL_MS) entries.delete(key);
  for (const [key, next] of successors) if (next.expires < now) successors.delete(key);
}

function followSuccessors(refresh: string, now: number): string {
  let current = refresh;
  for (let hop = 0; hop < 8; hop += 1) {
    const next = successors.get(digest(current));
    if (!next || next.expires < now) break;
    current = next.refresh;
  }
  return current;
}

/** Stores the tokens returned by login or register so the first API call needs no refresh. */
export function rememberSession(tokens: TokenPayload): void {
  const now = Date.now();
  entries.set(digest(tokens.refresh_token), {
    access: tokens.access_token,
    expiresAt: now + tokens.expires_in * 1000,
    refresh: tokens.refresh_token,
    lastUsed: now,
  });
}

export function forgetSession(refresh: string): void {
  entries.delete(digest(refresh));
}

/**
 * Returns an access token for the session behind the refresh token the browser sent, and the refresh token the
 * browser should hold from now on (different after a rotation). `rejectedAccess` is the token the API just
 * refused; a fresh one is fetched in that case even if the cache still has it.
 */
export async function accessTokenFor(browserRefresh: string, rejectedAccess?: string): Promise<{ access: string; refresh: string }> {
  const now = Date.now();
  sweep(now);
  const refresh = followSuccessors(browserRefresh, now);
  const key = digest(refresh);
  const cached = entries.get(key);
  if (cached && cached.expiresAt - ACCESS_SKEW_MS > now && cached.access !== rejectedAccess) {
    cached.lastUsed = now;
    return { access: cached.access, refresh };
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = refreshAt(refresh, key).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const entry = await pending;
  return { access: entry.access, refresh: entry.refresh };
}

async function refreshAt(refresh: string, key: string): Promise<Entry> {
  const res = await callBackend('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: refresh }) });
  if (res.status === 401) {
    entries.delete(key);
    throw new SessionExpiredError();
  }
  const tokens = readTokens(res);
  const now = Date.now();
  const entry: Entry = {
    access: tokens.access_token,
    expiresAt: now + tokens.expires_in * 1000,
    refresh: tokens.refresh_token,
    lastUsed: now,
  };
  entries.delete(key);
  successors.set(key, { refresh: tokens.refresh_token, expires: now + SUCCESSOR_TTL_MS });
  entries.set(digest(tokens.refresh_token), entry);
  return entry;
}
