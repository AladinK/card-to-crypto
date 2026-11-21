import { ConfigError } from './errors.js';

export interface AppConfig {
  port: number;
  /** Public origin of this app, no trailing slash. OAuth redirect is `${appUrl}/auth/callback`. */
  appUrl: string;
  databaseUrl: string;
  shopify: {
    apiKey: string;
    apiSecret: string;
    scopes: string;
    apiVersion: string;
    timeoutMs: number;
  };
  /** 32-byte AES-256-GCM key for Shopify access tokens at rest. */
  tokenEncryptionKey: Buffer;
  /** Secret for signing the OAuth state cookie. */
  cookieSecret: string;
  cardcrypto: {
    baseUrl: string;
    apiKey: string;
    webhookSecret: string;
    timeoutMs: number;
  };
  webhookClaimTtlSeconds: number;
}

const REQUIRED_VARIABLES = [
  'APP_URL',
  'DATABASE_URL',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'COOKIE_SECRET',
  'CARDCRYPTO_API_BASE_URL',
  'CARDCRYPTO_API_KEY',
  'CARDCRYPTO_WEBHOOK_SECRET',
] as const;

type Env = Readonly<Record<string, string | undefined>>;

export function parseTokenEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new ConfigError('TOKEN_ENCRYPTION_KEY must be the base64 encoding of exactly 32 bytes');
  }
  return key;
}

function requireBaseUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ConfigError(`${name} must use https (plain http is allowed only for localhost)`);
  }
  return raw.replace(/\/+$/, '');
}

function integerInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Validates the environment once at startup. Error messages name variables but never print values.
 */
export function loadConfig(env: Env): AppConfig {
  const missing = REQUIRED_VARIABLES.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment variables: ${missing.join(', ')}`);
  }
  const value = (name: (typeof REQUIRED_VARIABLES)[number]): string => (env[name] as string).trim();

  const cookieSecret = value('COOKIE_SECRET');
  if (cookieSecret.length < 32) throw new ConfigError('COOKIE_SECRET must be at least 32 characters');

  const cardcryptoApiKey = value('CARDCRYPTO_API_KEY');
  if (!/^sk_(test|live)_\S{20,}$/.test(cardcryptoApiKey)) {
    throw new ConfigError('CARDCRYPTO_API_KEY must be a sk_test_ or sk_live_ key');
  }
  const webhookSecret = value('CARDCRYPTO_WEBHOOK_SECRET');
  if (webhookSecret.length < 16) throw new ConfigError('CARDCRYPTO_WEBHOOK_SECRET must be at least 16 characters');

  const scopes = (env.SHOPIFY_SCOPES?.trim() || 'read_orders,write_orders')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
    .join(',');
  for (const required of ['read_orders', 'write_orders']) {
    if (!scopes.split(',').includes(required)) throw new ConfigError(`SHOPIFY_SCOPES must include ${required}`);
  }

  const apiVersion = env.SHOPIFY_API_VERSION?.trim() || '2026-10';
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new ConfigError('SHOPIFY_API_VERSION must look like 2026-10');

  return {
    port: integerInRange(env, 'PORT', 3000, 1, 65535),
    appUrl: requireBaseUrl('APP_URL', value('APP_URL')),
    databaseUrl: value('DATABASE_URL'),
    shopify: {
      apiKey: value('SHOPIFY_API_KEY'),
      apiSecret: value('SHOPIFY_API_SECRET'),
      scopes,
      apiVersion,
      timeoutMs: integerInRange(env, 'SHOPIFY_TIMEOUT_MS', 8000, 1000, 9000),
    },
    tokenEncryptionKey: parseTokenEncryptionKey(value('TOKEN_ENCRYPTION_KEY')),
    cookieSecret,
    cardcrypto: {
      baseUrl: requireBaseUrl('CARDCRYPTO_API_BASE_URL', value('CARDCRYPTO_API_BASE_URL')),
      apiKey: cardcryptoApiKey,
      webhookSecret,
      timeoutMs: integerInRange(env, 'CARDCRYPTO_TIMEOUT_MS', 4000, 500, 9000),
    },
    webhookClaimTtlSeconds: integerInRange(env, 'WEBHOOK_CLAIM_TTL_SECONDS', 300, 30, 86400),
  };
}
