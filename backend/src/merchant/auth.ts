import { SignJWT, jwtVerify } from 'jose';
import { err } from '../core/errors.js';
import type { Mode } from '../core/types.js';

export const JWT_ISSUER = 'cardcrypto';
export const JWT_AUDIENCE = 'cardcrypto-api';

export type Role = 'owner' | 'admin' | 'viewer';

/** Resolved caller. API keys act as the merchant's service account (role 'service'). */
export interface AuthContext {
  kind: 'user' | 'api_key';
  merchantId: string | null;
  mode: Mode;
  role: Role | 'service';
  userId: string | null;
  mfa: boolean;
  apiKeyId: string | null;
  platformAdmin: boolean;
  ip: string | null;
}

export interface AccessClaims {
  sub: string;
  mid: string | null;
  role: Role;
  mfa: boolean;
  pa: boolean;
  sid: string;
}

export async function signAccessToken(secret: string, ttlSeconds: number, claims: AccessClaims): Promise<string> {
  return new SignJWT({ mid: claims.mid, role: claims.role, mfa: claims.mfa, pa: claims.pa, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      mid: typeof payload.mid === 'string' ? payload.mid : null,
      role: (payload.role as Role) ?? 'viewer',
      mfa: payload.mfa === true,
      pa: payload.pa === true,
      sid: String(payload.sid ?? ''),
    };
  } catch {
    return null;
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

/** Write operations need admin or owner. API keys (service) are treated as owner-level for the merchant. */
export function canWrite(ctx: AuthContext): boolean {
  return ctx.role === 'service' || ROLE_RANK[ctx.role as Role] >= ROLE_RANK.admin;
}

export function canOwn(ctx: AuthContext): boolean {
  return ctx.role === 'service' || ctx.role === 'owner';
}

export function assertWritable(ctx: AuthContext): void {
  if (!canWrite(ctx)) throw err.forbidden('forbidden', 'Viewers cannot perform this action.');
}
