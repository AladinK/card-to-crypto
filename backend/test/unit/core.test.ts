import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { parseFiatAmount, formatFiat } from '../../src/core/money.js';
import { computeFiatFees, networkFeeFiatMinor, DEFAULT_FEE_SCHEDULE } from '../../src/core/fees.js';
import { convertFiatToCrypto, rateDeviationBps } from '../../src/core/conversion.js';
import { assertTransition, canTransition } from '../../src/core/states.js';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  parseApiKey,
  signWebhookPayload,
  totpCode,
  verifyTotp,
  verifyWebhookSignature,
  hashPassword,
  verifyPassword,
  generateTotpSecret,
} from '../../src/core/security.js';
import { assessRisk, isDisposableEmail, DEFAULT_RISK_THRESHOLDS, type RiskSignals } from '../../src/risk/engine.js';
import { isPrivateAddress } from '../../src/webhooks/net.js';
import { Decimal } from 'decimal.js';
import { CoinGeckoRateProvider, SandboxRateProvider } from '../../src/crypto-engine/rates.js';
import { CHAINS } from '../../src/core/assets.js';
import { isAddress } from 'viem';

describe('money', () => {
  it('parses decimal strings into cents without floats', () => {
    expect(parseFiatAmount('100')).toBe(10000n);
    expect(parseFiatAmount('100.5')).toBe(10050n);
    expect(parseFiatAmount('100.50')).toBe(10050n);
    expect(parseFiatAmount('0.01')).toBe(1n);
    expect(formatFiat(10050n)).toBe('100.50');
  });

  it('rejects malformed, zero and over-precise amounts', () => {
    for (const bad of ['100.555', '-1', '0', '0.00', '1e3', 'abc', '', '1,00']) {
      expect(() => parseFiatAmount(bad), bad).toThrow(AppError);
    }
  });
});

describe('fee engine', () => {
  it('deducts every fee from the gross amount in cents', () => {
    const fees = computeFiatFees({
      grossMinor: 10000n,
      networkFeeMinor: 10n,
      schedule: { paymentFeeBps: 150, paymentFeeFixedMinor: 25n, conversionFeeBps: 50, platformFeeBps: 50 },
    });
    expect(fees.paymentFeeMinor).toBe(175n); // 1.50% + 0.25
    expect(fees.conversionFeeMinor).toBe(50n);
    expect(fees.platformFeeMinor).toBe(50n);
    expect(fees.totalFeeMinor).toBe(285n);
    expect(fees.merchantNetMinor).toBe(9715n);
  });

  it('refuses amounts that do not cover fees', () => {
    expect(() => computeFiatFees({ grossMinor: 30n, networkFeeMinor: 5n, schedule: DEFAULT_FEE_SCHEDULE })).toThrow(AppError);
  });

  it('rounds network fees up so the platform never under-recovers', () => {
    // 0.0000001 ETH at 3000 EUR/ETH = 0.0003 EUR -> rounds up to 1 cent.
    const minor = networkFeeFiatMinor({ costBaseUnits: 100_000_000_000n, gasTokenDecimals: 18, gasTokenRateFiat: new Decimal(3000) });
    expect(minor).toBe(1n);
  });
});

describe('conversion engine', () => {
  it('converts net fiat into crypto base units, rounding down', () => {
    const fees = computeFiatFees({
      grossMinor: 10000n,
      networkFeeMinor: 10n,
      schedule: { paymentFeeBps: 150, paymentFeeFixedMinor: 25n, conversionFeeBps: 50, platformFeeBps: 50 },
    });
    const result = convertFiatToCrypto({ fees, rate: new Decimal('0.92'), decimals: 6 });
    expect(result.grossCryptoBase).toBe(108_695_652n); // 100 / 0.92 = 108.695652...
    expect(result.merchantNetBase).toBe(105_597_826n); // 97.15 / 0.92 = 105.597826...
    expect(result.merchantNetFiatMinor).toBe(9715n);
  });

  it('rejects zero or invalid rates', () => {
    const fees = computeFiatFees({ grossMinor: 10000n, networkFeeMinor: 0n, schedule: DEFAULT_FEE_SCHEDULE });
    expect(() => convertFiatToCrypto({ fees, rate: new Decimal(0), decimals: 6 })).toThrow(AppError);
  });

  it('measures rate movement in basis points', () => {
    expect(rateDeviationBps(new Decimal('0.92'), new Decimal('0.9292'))).toBe(100);
    expect(rateDeviationBps(new Decimal('0.92'), new Decimal('0.92'))).toBe(0);
  });
});

describe('payment state machine', () => {
  it('allows the forward path and blocks skipped or reversed steps', () => {
    expect(canTransition('CREATED', 'PAYMENT_PENDING')).toBe(true);
    expect(canTransition('PAYMENT_PENDING', 'PAYMENT_CAPTURED')).toBe(true);
    expect(canTransition('PAYMENT_PENDING', 'SETTLED')).toBe(false);
    expect(canTransition('SETTLED', 'CONVERSION_PENDING')).toBe(false);
    expect(canTransition('CANCELLED', 'PAYMENT_PENDING')).toBe(false);
    expect(() => assertTransition('REFUNDED', 'SETTLED')).toThrow(AppError);
  });

  it('only allows a dropped transfer to be signed again, never directly confirmed from pending', () => {
    expect(canTransition('CRYPTO_TRANSFER_SUBMITTED', 'CRYPTO_TRANSFER_PENDING')).toBe(true);
    expect(canTransition('CRYPTO_TRANSFER_PENDING', 'SETTLED')).toBe(false);
  });
});

describe('security primitives', () => {
  it('matches the RFC 6238 SHA-1 test vector and round-trips base32', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, 1)).toBe('287082'); // T = 59s
  });

  it('verifies TOTP within the window and blocks replay of the same step', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2030, 0, 1, 12, 0, 0);
    const code = totpCode(secret, Math.floor(now / 30_000));
    const first = verifyTotp(secret, code, { nowMs: now });
    expect(first.ok).toBe(true);
    expect(verifyTotp(secret, code, { nowMs: now, lastUsedStep: first.step }).ok).toBe(false);
    expect(verifyTotp(secret, '000000', { nowMs: now }).ok).toBe(false);
  });

  it('encrypts secrets with AES-256-GCM and detects tampering', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const sealed = encryptSecret('whsec_top_secret', key);
    expect(sealed).not.toContain('whsec_top_secret');
    expect(decryptSecret(sealed, key)).toBe('whsec_top_secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('hashes passwords with scrypt and verifies them in constant time', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong password here', stored)).toBe(false);
  });

  it('signs webhooks and rejects tampering and stale timestamps', () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ event: 'settlement.confirmed' });
    const now = 1_800_000_000;
    const header = signWebhookPayload(secret, now, body);
    expect(verifyWebhookSignature({ header, rawBody: body, secret, nowSeconds: now }).ok).toBe(true);
    expect(verifyWebhookSignature({ header, rawBody: body + ' ', secret, nowSeconds: now }).ok).toBe(false);
    expect(verifyWebhookSignature({ header, rawBody: body, secret: 'other', nowSeconds: now }).ok).toBe(false);
    expect(verifyWebhookSignature({ header, rawBody: body, secret, nowSeconds: now + 3600 }).reason).toBe('timestamp_out_of_tolerance');
    expect(verifyWebhookSignature({ header: undefined, rawBody: body, secret }).reason).toBe('missing_signature');
  });

  it('issues API keys with a parseable prefix and a 256-bit secret', () => {
    const { token, keyPrefix } = generateApiKey('live');
    expect(parseApiKey(token)).toEqual({ keyPrefix, mode: 'live' });
    expect(parseApiKey(token.slice(0, -1) + 'x!')).toBeNull();
    expect(parseApiKey('sk_test_nope')).toBeNull();
  });
});

describe('risk engine', () => {
  const base: RiskSignals = {
    amountMinor: 5000n,
    highValueMinor: 200000n,
    paymentsLastHourSameEmail: 0,
    paymentsLastHourSameIp: 0,
    failedLast24hSameEmail: 0,
    disposableEmail: false,
    ipReputation: 'unknown',
    processorRisk: null,
    billingCountry: null,
    cardCountry: null,
    externalScore: 0,
    externalReasons: [],
  };

  it('scores ordinary checkouts as LOW with no reasons', () => {
    expect(assessRisk(base, DEFAULT_RISK_THRESHOLDS)).toEqual({ score: 0, level: 'LOW', reasons: [] });
  });

  it('escalates velocity, repeated failures and value', () => {
    const risky = assessRisk(
      { ...base, paymentsLastHourSameEmail: 6, failedLast24hSameEmail: 3, amountMinor: 1_000_001n },
      DEFAULT_RISK_THRESHOLDS,
    );
    expect(risky.level).toBe('BLOCKED');
    expect(risky.reasons).toEqual(expect.arrayContaining(['velocity_email_high', 'repeated_failed_payments', 'value_very_high']));
  });

  it('flags disposable email domains and bad IP reputation', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@shop.rs')).toBe(false);
    expect(assessRisk({ ...base, ipReputation: 'bad' }, DEFAULT_RISK_THRESHOLDS).level).toBe('HIGH'); // 60 points = high threshold
  });
});

describe('network safety for outbound webhooks', () => {
  it('classifies loopback, private, link-local and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.9', '172.20.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.1.1.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('rates', () => {
  it('derives sandbox rates from USD prices and fiat cross rates', async () => {
    const rates = new SandboxRateProvider();
    expect((await rates.getRate('USDC', 'EUR')).rate.toFixed(2)).toBe('0.92');
    rates.setUsdPrice('USDC', '1.01');
    expect((await rates.getRate('USDC', 'USD')).rate.toFixed(2)).toBe('1.01');
  });

  it('parses the live source, caches it and rejects unusable answers', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ 'usd-coin': { eur: 0.9213 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new CoinGeckoRateProvider({ baseUrl: 'https://rates.example', fetchImpl, cacheTtlMs: 10_000 });
    const first = await provider.getRate('USDC', 'EUR');
    expect(first.rate.toFixed(4)).toBe('0.9213');
    await provider.getRate('USDC', 'EUR');
    expect(calls).toBe(1);

    const broken = new CoinGeckoRateProvider({
      baseUrl: 'https://rates.example',
      fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(broken.getRate('USDC', 'EUR')).rejects.toBeInstanceOf(AppError);
  });
});

describe('chain registry', () => {
  it('has only valid, checksum-correct token contracts', () => {
    for (const chain of Object.values(CHAINS)) {
      for (const [asset, address] of Object.entries(chain.tokens)) {
        expect(isAddress(address as string, { strict: true }), `${chain.key} ${asset}`).toBe(true);
      }
    }
  });
});
