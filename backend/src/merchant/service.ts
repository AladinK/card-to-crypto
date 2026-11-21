import { AppError, err } from '../core/errors.js';
import { decryptSecret, encryptSecret, generateApiKey, generateTotpSecret, hashApiKey, hashPassword, newId, parseApiKey, randomRefreshToken, safeEqual, sha256Hex, verifyPassword, verifyTotp, totpCode } from '../core/security.js';
import { DEFAULT_RISK_THRESHOLDS, type RiskThresholds } from '../risk/engine.js';
import type { Mode } from '../core/types.js';
import type { AppConfig } from '../config.js';
import { withTransaction, type Db, type Queryable, type Tx } from '../db/pool.js';
import { appendAudit } from '../audit/audit.js';
import { canOwn, signAccessToken, type AuthContext, type Role } from './auth.js';
import type { FeeSchedule } from '../core/fees.js';

export interface MerchantRecord {
  id: string;
  name: string;
  legal_name: string | null;
  country: string | null;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  kyb_status: 'PENDING' | 'APPROVED' | 'REJECTED';
  live_enabled: boolean;
  settlement_review_threshold_minor: bigint;
  high_value_threshold_minor: bigint;
  max_rate_deviation_bps: number;
  order_paid_trigger: 'PAYMENT_CAPTURED' | 'SETTLEMENT_CONFIRMED';
  risk_thresholds: RiskThresholds;
  fee_schedule: FeeSchedule | null;
  created_at: Date;
}

export function mapMerchant(row: Record<string, unknown>): MerchantRecord {
  const feeRaw = row.fee_schedule as Record<string, unknown> | null;
  return {
    id: String(row.id),
    name: String(row.name),
    legal_name: (row.legal_name as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    status: row.status as MerchantRecord['status'],
    kyb_status: row.kyb_status as MerchantRecord['kyb_status'],
    live_enabled: Boolean(row.live_enabled),
    settlement_review_threshold_minor: BigInt(String(row.settlement_review_threshold_minor)),
    high_value_threshold_minor: BigInt(String(row.high_value_threshold_minor)),
    max_rate_deviation_bps: Number(row.max_rate_deviation_bps),
    order_paid_trigger: row.order_paid_trigger as MerchantRecord['order_paid_trigger'],
    risk_thresholds: { ...DEFAULT_RISK_THRESHOLDS, ...((row.risk_thresholds as Partial<RiskThresholds>) ?? {}) },
    fee_schedule: feeRaw
      ? {
          paymentFeeBps: Number(feeRaw.paymentFeeBps),
          paymentFeeFixedMinor: BigInt(String(feeRaw.paymentFeeFixedMinor)),
          conversionFeeBps: Number(feeRaw.conversionFeeBps),
          platformFeeBps: Number(feeRaw.platformFeeBps),
        }
      : null,
    created_at: new Date(String(row.created_at)),
  };
}

export async function loadMerchant(db: Queryable, id: string): Promise<MerchantRecord> {
  const { rows } = await db.query('SELECT * FROM merchants WHERE id = $1', [id]);
  if (!rows[0]) throw err.notFound('Merchant');
  return mapMerchant(rows[0]);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

let dummyHashPromise: Promise<string> | null = null;

/** Constant-ish timing for unknown emails: verify against a dummy hash. */
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing');
  return dummyHashPromise;
}

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const MAX_API_KEYS = 25;

export class MerchantService {
  constructor(
    private readonly deps: { db: Db; config: AppConfig },
  ) {}

  // -------------------------------------------------------------------------
  // Registration, login, sessions
  // -------------------------------------------------------------------------

  async register(input: {
    merchantName: string;
    email: string;
    password: string;
    country: string | null;
    ip: string | null;
  }): Promise<{ merchant_id: string; user_id: string } & SessionTokens> {
    if (input.password.length < 12) throw err.unprocessable('weak_password', 'Password must be at least 12 characters.');
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const merchantId = newId('mer');
    const userId = newId('usr');

    try {
      await withTransaction(this.deps.db, async (tx) => {
        await tx.query('INSERT INTO merchants (id, name, country) VALUES ($1, $2, $3)', [merchantId, input.merchantName, input.country]);
        await tx.query(
          "INSERT INTO users (id, merchant_id, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner')",
          [userId, merchantId, email, passwordHash],
        );
        await appendAudit(tx, {
          actorType: 'user',
          actorId: userId,
          merchantId,
          action: 'merchant.registered',
          entityType: 'merchant',
          entityId: merchantId,
          ip: input.ip,
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw err.conflict('email_taken', 'An account with this email already exists.');
      }
      throw error;
    }

    const session = await this.issueSession(
      { id: userId, merchant_id: merchantId, role: 'owner', is_platform_admin: false },
      false,
      null,
    );
    return { merchant_id: merchantId, user_id: userId, ...session };
  }

  async login(input: { email: string; password: string; totpCode?: string | undefined; ip: string | null }): Promise<SessionTokens & { user_id: string; mfa: boolean }> {
    const email = normalizeEmail(input.email);
    const { rows } = await this.deps.db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) {
      await verifyPassword(input.password, await dummyHash());
      throw err.unauthorized('Invalid email or password.');
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new AppError(423, 'account_locked', 'Too many failed attempts. Try again later.');
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk) {
      await this.recordFailedLogin(user.id);
      throw err.unauthorized('Invalid email or password.');
    }

    let mfa = false;
    if (user.totp_enabled) {
      if (!input.totpCode) throw new AppError(401, 'totp_required', 'Enter the 6-digit code from your authenticator app.');
      const secret = decryptSecret(user.totp_secret_enc, this.deps.config.dataEncryptionKey);
      const result = verifyTotp(secret, input.totpCode, { lastUsedStep: user.totp_last_step === null ? null : Number(user.totp_last_step) });
      if (!result.ok || result.step === undefined) {
        await this.recordFailedLogin(user.id);
        throw err.unauthorized('Invalid authentication code.');
      }
      await this.deps.db.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [user.id, result.step]);
      mfa = true;
    }

    await this.deps.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
    const session = await this.issueSession(user, mfa, null);
    return { ...session, user_id: user.id, mfa };
  }

  private async recordFailedLogin(userId: string): Promise<void> {
    await this.deps.db.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [userId, MAX_FAILED_LOGINS, LOCK_MINUTES],
    );
  }

  private async issueSession(
    user: { id: string; merchant_id: string | null; role: Role; is_platform_admin: boolean },
    mfa: boolean,
    familyId: string | null,
  ): Promise<SessionTokens> {
    const refresh = randomRefreshToken();
    const sessionId = newId('ses');
    const family = familyId ?? newId('fam');
    const ttlDays = this.deps.config.refreshTokenTtlDays;
    await this.deps.db.query(
      `INSERT INTO auth_sessions (id, user_id, family_id, refresh_token_hash, mfa_verified, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
      [sessionId, user.id, family, refresh.hash, mfa, ttlDays],
    );
    const ttl = this.deps.config.accessTokenTtlSeconds;
    const access = await signAccessToken(this.deps.config.jwtSecret, ttl, {
      sub: user.id,
      mid: user.merchant_id,
      role: user.role,
      mfa,
      pa: user.is_platform_admin,
      sid: sessionId,
    });
    return { access_token: access, refresh_token: refresh.token, token_type: 'Bearer', expires_in: ttl };
  }

  /** Rotates the refresh token. Presenting a revoked token revokes the whole family (theft detection). */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    const hash = sha256Hex(refreshToken);
    const { rows } = await this.deps.db.query(
      `SELECT s.id, s.family_id, s.revoked_at, s.expires_at, s.mfa_verified, u.id AS user_id, u.merchant_id, u.role, u.is_platform_admin
       FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_token_hash = $1`,
      [hash],
    );
    const row = rows[0];
    if (!row) throw err.unauthorized('Invalid refresh token.');
    if (row.revoked_at) {
      await this.deps.db.query('UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
      throw err.unauthorized('Refresh token was already used. Please sign in again.');
    }
    if (new Date(row.expires_at) <= new Date()) throw err.unauthorized('Refresh token expired.');

    return withTransaction(this.deps.db, async (tx) => {
      const next = await this.createSessionRow(tx, row.user_id, row.family_id, Boolean(row.mfa_verified));
      await tx.query('UPDATE auth_sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1 AND revoked_at IS NULL', [row.id, next.sessionId]);
      const ttl = this.deps.config.accessTokenTtlSeconds;
      const access = await signAccessToken(this.deps.config.jwtSecret, ttl, {
        sub: row.user_id,
        mid: row.merchant_id,
        role: row.role,
        mfa: Boolean(row.mfa_verified),
        pa: Boolean(row.is_platform_admin),
        sid: next.sessionId,
      });
      return { access_token: access, refresh_token: next.token, token_type: 'Bearer' as const, expires_in: ttl };
    });
  }

  private async createSessionRow(tx: Tx, userId: string, family: string, mfa: boolean): Promise<{ sessionId: string; token: string }> {
    const refresh = randomRefreshToken();
    const sessionId = newId('ses');
    await tx.query(
      `INSERT INTO auth_sessions (id, user_id, family_id, refresh_token_hash, mfa_verified, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
      [sessionId, userId, family, refresh.hash, mfa, this.deps.config.refreshTokenTtlDays],
    );
    return { sessionId, token: refresh.token };
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = sha256Hex(refreshToken);
    await this.deps.db.query(
      `UPDATE auth_sessions SET revoked_at = now()
       WHERE family_id = (SELECT family_id FROM auth_sessions WHERE refresh_token_hash = $1) AND revoked_at IS NULL`,
      [hash],
    );
  }

  // -------------------------------------------------------------------------
  // Two-factor authentication (TOTP)
  // -------------------------------------------------------------------------

  async mfaSetup(userId: string): Promise<{ secret: string; otpauth_uri: string }> {
    const { rows } = await this.deps.db.query('SELECT email, totp_enabled FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user) throw err.notFound('User');
    if (user.totp_enabled) throw err.conflict('mfa_already_enabled', 'Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    await this.deps.db.query('UPDATE users SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1', [
      userId,
      encryptSecret(secret, this.deps.config.dataEncryptionKey),
    ]);
    const label = encodeURIComponent(`CardCrypto:${user.email}`);
    return {
      secret,
      otpauth_uri: `otpauth://totp/${label}?secret=${secret}&issuer=CardCrypto&algorithm=SHA1&digits=6&period=30`,
    };
  }

  async mfaEnable(userId: string, code: string): Promise<void> {
    const { rows } = await this.deps.db.query('SELECT totp_secret_enc, totp_enabled FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user || !user.totp_secret_enc) throw err.badRequest('mfa_not_initialized', 'Call mfa/setup first.');
    if (user.totp_enabled) throw err.conflict('mfa_already_enabled', 'Two-factor authentication is already enabled.');
    const secret = decryptSecret(user.totp_secret_enc, this.deps.config.dataEncryptionKey);
    const result = verifyTotp(secret, code);
    if (!result.ok || result.step === undefined) throw err.unauthorized('Invalid authentication code.');
    await withTransaction(this.deps.db, async (tx) => {
      await tx.query('UPDATE users SET totp_enabled = TRUE, totp_last_step = $2 WHERE id = $1', [userId, result.step]);
      await appendAudit(tx, { actorType: 'user', actorId: userId, action: 'mfa.enabled', entityType: 'user', entityId: userId });
    });
  }

  /** Exposed for tests: the code a user's authenticator would show at `nowMs`. */
  static currentCode(secret: string, nowMs: number = Date.now()): string {
    return totpCode(secret, Math.floor(nowMs / 30_000));
  }

  // -------------------------------------------------------------------------
  // Me
  // -------------------------------------------------------------------------

  async me(ctx: AuthContext): Promise<Record<string, unknown>> {
    if (!ctx.userId) throw err.unauthorized();
    const { rows } = await this.deps.db.query(
      'SELECT id, email, role, merchant_id, is_platform_admin, totp_enabled FROM users WHERE id = $1',
      [ctx.userId],
    );
    const user = rows[0];
    if (!user) throw err.unauthorized();
    const merchant = user.merchant_id ? await loadMerchant(this.deps.db, user.merchant_id) : null;
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mfa_enabled: user.totp_enabled,
        platform_admin: user.is_platform_admin,
      },
      merchant: merchant && {
        id: merchant.id,
        name: merchant.name,
        status: merchant.status,
        kyb_status: merchant.kyb_status,
        live_enabled: merchant.live_enabled,
      },
    };
  }

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------

  async listApiKeys(merchantId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.deps.db.query(
      `SELECT id, name, mode, key_prefix, created_at, last_used_at, expires_at, revoked_at
       FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [merchantId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      mode: r.mode,
      key_prefix: r.key_prefix,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
    }));
  }

  async createApiKey(ctx: AuthContext, input: { name: string; mode: Mode }): Promise<Record<string, unknown>> {
    const merchantId = requireMerchant(ctx);
    if (!canOwn(ctx) && ctx.kind === 'user') throw err.forbidden('forbidden', 'Only owners can create API keys.');
    const merchant = await loadMerchant(this.deps.db, merchantId);
    await this.assertModeAllowed(ctx, merchant, input.mode);

    const { rows: countRows } = await this.deps.db.query(
      'SELECT count(*)::int AS n FROM api_keys WHERE merchant_id = $1 AND revoked_at IS NULL',
      [merchantId],
    );
    if ((countRows[0]?.n ?? 0) >= MAX_API_KEYS) throw err.conflict('api_key_limit', 'API key limit reached. Revoke unused keys first.');

    const { token, keyPrefix } = generateApiKey(input.mode);
    const id = newId('key');
    await withTransaction(this.deps.db, async (tx) => {
      await tx.query(
        'INSERT INTO api_keys (id, merchant_id, mode, name, key_prefix, secret_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, merchantId, input.mode, input.name, keyPrefix, hashApiKey(this.deps.config.apiKeyPepper, token), ctx.userId],
      );
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'api_key.created',
        entityType: 'api_key',
        entityId: id,
        data: { mode: input.mode, name: input.name },
        ip: ctx.ip,
      });
    });
    // The secret is returned exactly once and never stored in plaintext.
    return { id, name: input.name, mode: input.mode, key_prefix: keyPrefix, secret: token };
  }

  /** Creates a replacement key and schedules the old one to expire after a grace period. */
  async rotateApiKey(ctx: AuthContext, keyId: string, graceHours: number): Promise<Record<string, unknown>> {
    const merchantId = requireMerchant(ctx);
    const { rows } = await this.deps.db.query('SELECT * FROM api_keys WHERE id = $1 AND merchant_id = $2', [keyId, merchantId]);
    const old = rows[0];
    if (!old || old.revoked_at) throw err.notFound('API key');
    const replacement = await this.createApiKey(ctx, { name: `${old.name} (rotated)`, mode: old.mode as Mode });
    await withTransaction(this.deps.db, async (tx) => {
      await tx.query(
        `UPDATE api_keys SET expires_at = CASE WHEN $2::int <= 0 THEN now()
           ELSE LEAST(COALESCE(expires_at, 'infinity'::timestamptz), now() + make_interval(hours => $2::int)) END,
           revoked_at = CASE WHEN $2::int <= 0 THEN now() ELSE revoked_at END
         WHERE id = $1`,
        [keyId, graceHours],
      );
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'api_key.rotated',
        entityType: 'api_key',
        entityId: keyId,
        data: { replacement: replacement['id'], grace_hours: graceHours },
        ip: ctx.ip,
      });
    });
    return { ...replacement, rotated_from: keyId, old_key_expires_grace_hours: graceHours };
  }

  async revokeApiKey(ctx: AuthContext, keyId: string): Promise<void> {
    const merchantId = requireMerchant(ctx);
    await withTransaction(this.deps.db, async (tx) => {
      const result = await tx.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL', [keyId, merchantId]);
      if (result.rowCount === 0) throw err.notFound('API key');
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'api_key.revoked',
        entityType: 'api_key',
        entityId: keyId,
        ip: ctx.ip,
      });
    });
  }

  /** Resolves `sk_<mode>_…` tokens. Returns null for unknown, revoked, or expired keys. */
  async authenticateApiKey(token: string, ip: string | null): Promise<AuthContext | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    const { rows } = await this.deps.db.query('SELECT * FROM api_keys WHERE key_prefix = $1', [parsed.keyPrefix]);
    const row = rows[0];
    if (!row) return null;
    const expected = hashApiKey(this.deps.config.apiKeyPepper, token);
    if (!safeEqual(expected, row.secret_hash)) return null;
    if (row.revoked_at || (row.expires_at && new Date(row.expires_at) <= new Date())) return null;
    const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > 60_000) {
      this.deps.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
    }
    return {
      kind: 'api_key',
      merchantId: row.merchant_id,
      mode: row.mode,
      role: 'service',
      userId: null,
      mfa: false,
      apiKeyId: row.id,
      platformAdmin: false,
      ip,
    };
  }

  private async assertModeAllowed(ctx: AuthContext, merchant: MerchantRecord, mode: Mode): Promise<void> {
    if (mode !== 'live') return;
    if (!merchant.live_enabled) throw err.forbidden('live_mode_not_enabled', 'Live mode is not enabled for this account.');
    if (merchant.kyb_status !== 'APPROVED') throw err.forbidden('kyb_not_approved', 'Business verification must be approved before live keys are issued.');
    if (this.deps.config.requireMfaForLive && ctx.kind === 'user' && !ctx.mfa) {
      throw err.forbidden('mfa_required', 'Sign in with two-factor authentication to perform this action.');
    }
  }

  // -------------------------------------------------------------------------
  // Stores
  // -------------------------------------------------------------------------

  async listStores(merchantId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.deps.db.query('SELECT * FROM stores WHERE merchant_id = $1 ORDER BY created_at', [merchantId]);
    return rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, domain: r.domain, created_at: r.created_at }));
  }

  async createStore(merchantId: string, input: { name: string; platform: string; domain: string | null }): Promise<Record<string, unknown>> {
    const id = newId('str');
    await this.deps.db.query('INSERT INTO stores (id, merchant_id, name, platform, domain) VALUES ($1, $2, $3, $4, $5)', [
      id,
      merchantId,
      input.name,
      input.platform,
      input.domain,
    ]);
    return { id, name: input.name, platform: input.platform, domain: input.domain };
  }
}

export function requireMerchant(ctx: AuthContext): string {
  if (!ctx.merchantId) throw err.forbidden('merchant_required', 'This endpoint requires a merchant account.');
  return ctx.merchantId;
}
