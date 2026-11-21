import 'server-only';

/**
 * Cookie names and options. The refresh token is the only credential the browser holds, and it is httpOnly.
 * The mode and theme cookies are preferences; they carry no credentials.
 */
export const REFRESH_COOKIE = 'cc_rt';
export const MODE_COOKIE = 'cc_mode';

/** Matches the API's default refresh-token lifetime (REFRESH_TOKEN_TTL_DAYS=14). */
const SESSION_SECONDS = 14 * 24 * 60 * 60;

const secure = () => process.env.NODE_ENV === 'production';

export function refreshCookieOptions(maxAge: number = SESSION_SECONDS) {
  return { httpOnly: true, secure: secure(), sameSite: 'lax' as const, path: '/', maxAge };
}

export function modeCookieOptions(maxAge: number = SESSION_SECONDS) {
  return { httpOnly: true, secure: secure(), sameSite: 'lax' as const, path: '/', maxAge };
}

/** The API issues base64url tokens of 43 characters. Anything else is rejected before it leaves the server. */
export function isValidRefreshToken(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(value);
}
