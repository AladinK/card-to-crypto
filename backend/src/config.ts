import { z } from 'zod';
import { hmacHex } from './core/security.js';
import { DEFAULT_FEE_SCHEDULE, type FeeSchedule } from './core/fees.js';
import { CHAINS, type ChainKey } from './core/assets.js';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  publicBaseUrl: string;
  dashboardOrigins: string[];
  databaseUrl: string;
  jwtSecret: string;
  apiKeyPepper: string;
  dataEncryptionKey: string;
  /** Derived from JWT_SECRET; authenticates events posted by the sandbox provider simulator. */
  sandboxWebhookSecret: string;
  liveModeEnabled: boolean;
  stripe: { secretKey: string; webhookSecret: string } | null;
  coingecko: { baseUrl: string; apiKey: string | undefined };
  rpcUrls: Partial<Record<ChainKey, string[]>>;
  confirmations: Partial<Record<ChainKey, number>>;
  treasuryPrivateKey: `0x${string}` | null;
  fees: FeeSchedule;
  walletActivationDelayHours: number;
  checkoutTtlMinutes: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  requireMfaForLive: boolean;
  /** Dev/test only: allows webhook deliveries to private addresses. Refused in production. */
  webhookAllowPrivateTargets: boolean;
  workerPollMs: number;
  sandboxBlockTimeMs: number;
  sandboxInclusionDelayMs: number;
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const boolFlag = (fallback: boolean) =>
  optionalString.transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const intWithDefault = (fallback: number) =>
  optionalString.transform((v) => {
    if (v === undefined) return fallback;
    const parsed = Number(v);
    if (!Number.isInteger(parsed)) throw new Error(`Expected integer, got "${v}".`);
    return parsed;
  });

const csvUrls = optionalString.transform((v) =>
  v === undefined ? [] : v.split(',').map((s) => s.trim()).filter(Boolean),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intWithDefault(3000),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  DASHBOARD_ORIGINS: optionalString.transform((v) =>
    (v ?? 'http://localhost:3001').split(',').map((s) => s.trim()).filter(Boolean),
  ),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  API_KEY_PEPPER: z.string().min(32, 'API_KEY_PEPPER must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: z.string().min(1, 'DATA_ENCRYPTION_KEY is required (32 bytes, base64)'),
  LIVE_MODE_ENABLED: boolFlag(false),
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  COINGECKO_BASE_URL: z.url().default('https://api.coingecko.com/api/v3'),
  COINGECKO_API_KEY: optionalString,
  RPC_URLS_ETHEREUM: csvUrls,
  RPC_URLS_POLYGON: csvUrls,
  RPC_URLS_BASE: csvUrls,
  RPC_URLS_ARBITRUM: csvUrls,
  CONFIRMATIONS_ETHEREUM: optionalString,
  CONFIRMATIONS_POLYGON: optionalString,
  CONFIRMATIONS_BASE: optionalString,
  CONFIRMATIONS_ARBITRUM: optionalString,
  TREASURY_PRIVATE_KEY: optionalString,
  UNSAFE_ALLOW_ENV_SIGNER: boolFlag(false),
  FEE_PAYMENT_BPS: intWithDefault(DEFAULT_FEE_SCHEDULE.paymentFeeBps),
  FEE_PAYMENT_FIXED_MINOR: intWithDefault(Number(DEFAULT_FEE_SCHEDULE.paymentFeeFixedMinor)),
  FEE_CONVERSION_BPS: intWithDefault(DEFAULT_FEE_SCHEDULE.conversionFeeBps),
  FEE_PLATFORM_BPS: intWithDefault(DEFAULT_FEE_SCHEDULE.platformFeeBps),
  WALLET_ACTIVATION_DELAY_HOURS: intWithDefault(24),
  CHECKOUT_TTL_MINUTES: intWithDefault(30),
  ACCESS_TOKEN_TTL_SECONDS: intWithDefault(900),
  REFRESH_TOKEN_TTL_DAYS: intWithDefault(14),
  REQUIRE_MFA_FOR_LIVE: boolFlag(true),
  WEBHOOK_ALLOW_PRIVATE_TARGETS: boolFlag(false),
  WORKER_POLL_MS: intWithDefault(1000),
  SANDBOX_BLOCK_TIME_MS: intWithDefault(1000),
  SANDBOX_INCLUSION_DELAY_MS: intWithDefault(1500),
});

/** Loads and validates configuration. Throws with a readable message when the deployment is unsafe. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  const dataKey = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
  if (dataKey.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (base64).');
  }

  const rpcUrls: Partial<Record<ChainKey, string[]>> = {};
  const rpcByChain: Record<ChainKey, string[]> = {
    ethereum: env.RPC_URLS_ETHEREUM,
    polygon: env.RPC_URLS_POLYGON,
    base: env.RPC_URLS_BASE,
    arbitrum: env.RPC_URLS_ARBITRUM,
  };
  for (const key of Object.keys(CHAINS) as ChainKey[]) {
    const urls = rpcByChain[key];
    if (urls.length > 0) rpcUrls[key] = urls;
  }

  const confirmations: Partial<Record<ChainKey, number>> = {};
  const confValues: Record<ChainKey, string | undefined> = {
    ethereum: env.CONFIRMATIONS_ETHEREUM,
    polygon: env.CONFIRMATIONS_POLYGON,
    base: env.CONFIRMATIONS_BASE,
    arbitrum: env.CONFIRMATIONS_ARBITRUM,
  };
  for (const key of Object.keys(CHAINS) as ChainKey[]) {
    const raw = confValues[key];
    if (raw !== undefined) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) throw new Error(`CONFIRMATIONS_${key.toUpperCase()} must be >= 1.`);
      confirmations[key] = value;
    }
  }

  const stripe =
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
      ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }
      : null;

  const treasuryPrivateKey = env.TREASURY_PRIVATE_KEY
    ? (env.TREASURY_PRIVATE_KEY as `0x${string}`)
    : null;

  // Live-mode guard rails. Live must never start with sandbox providers or without a signer.
  if (env.LIVE_MODE_ENABLED) {
    if (!stripe) throw new Error('LIVE_MODE_ENABLED requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.');
    if (Object.keys(rpcUrls).length === 0) throw new Error('LIVE_MODE_ENABLED requires at least one RPC_URLS_* value.');
    if (!treasuryPrivateKey) throw new Error('LIVE_MODE_ENABLED requires a treasury signer (see docs/DEPLOYMENT.md).');
    if (isProduction && !env.UNSAFE_ALLOW_ENV_SIGNER) {
      throw new Error(
        'In production the treasury key must come from KMS/HSM. Set UNSAFE_ALLOW_ENV_SIGNER=true only for staging.',
      );
    }
  }
  if (isProduction && env.WEBHOOK_ALLOW_PRIVATE_TARGETS) {
    throw new Error('WEBHOOK_ALLOW_PRIVATE_TARGETS cannot be enabled in production.');
  }

  return {
    env: env.NODE_ENV,
    isProduction,
    port: env.PORT,
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ''),
    dashboardOrigins: env.DASHBOARD_ORIGINS,
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.JWT_SECRET,
    apiKeyPepper: env.API_KEY_PEPPER,
    dataEncryptionKey: env.DATA_ENCRYPTION_KEY,
    sandboxWebhookSecret: hmacHex(env.JWT_SECRET, 'sandbox-provider-webhook-v1'),
    liveModeEnabled: env.LIVE_MODE_ENABLED,
    stripe,
    coingecko: { baseUrl: env.COINGECKO_BASE_URL.replace(/\/$/, ''), apiKey: env.COINGECKO_API_KEY },
    rpcUrls,
    confirmations,
    treasuryPrivateKey,
    fees: {
      paymentFeeBps: env.FEE_PAYMENT_BPS,
      paymentFeeFixedMinor: BigInt(env.FEE_PAYMENT_FIXED_MINOR),
      conversionFeeBps: env.FEE_CONVERSION_BPS,
      platformFeeBps: env.FEE_PLATFORM_BPS,
    },
    walletActivationDelayHours: env.WALLET_ACTIVATION_DELAY_HOURS,
    checkoutTtlMinutes: env.CHECKOUT_TTL_MINUTES,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    requireMfaForLive: env.REQUIRE_MFA_FOR_LIVE,
    webhookAllowPrivateTargets: env.WEBHOOK_ALLOW_PRIVATE_TARGETS,
    workerPollMs: env.WORKER_POLL_MS,
    sandboxBlockTimeMs: env.SANDBOX_BLOCK_TIME_MS,
    sandboxInclusionDelayMs: env.SANDBOX_INCLUSION_DELAY_MS,
  };
}
