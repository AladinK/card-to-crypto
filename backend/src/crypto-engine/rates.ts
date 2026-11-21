import { Decimal } from 'decimal.js';
import { ASSETS, type AssetCode } from '../core/assets.js';
import { err } from '../core/errors.js';
import type { FiatCurrency } from '../core/money.js';

export interface RateSnapshot {
  /** Fiat major units per 1 unit of the crypto asset (e.g. 0.92 EUR per USDC). */
  rate: Decimal;
  source: string;
  fetchedAt: Date;
}

export interface RateProvider {
  readonly source: string;
  getRate(asset: AssetCode, fiat: FiatCurrency): Promise<RateSnapshot>;
}

export interface CoinGeckoOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Live rate source (CoinGecko simple price). The public tier is rate-limited and has no SLA:
 * production should use a contracted price feed (see docs/LEGAL_AND_TECHNICAL_DEPENDENCIES.md).
 */
export class CoinGeckoRateProvider implements RateProvider {
  readonly source = 'coingecko';
  private readonly cache = new Map<string, { snapshot: RateSnapshot; expiresAt: number }>();

  constructor(private readonly options: CoinGeckoOptions) {}

  async getRate(asset: AssetCode, fiat: FiatCurrency): Promise<RateSnapshot> {
    const now = this.options.now?.() ?? Date.now();
    const key = `${asset}:${fiat}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.snapshot;

    const coinId = ASSETS[asset].coingeckoId;
    const url = new URL(`${this.options.baseUrl}/simple/price`);
    url.searchParams.set('ids', coinId);
    url.searchParams.set('vs_currencies', fiat.toLowerCase());
    url.searchParams.set('precision', 'full');

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.apiKey) headers['x-cg-demo-api-key'] = this.options.apiKey;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw err.upstream('rate_source_error', `Rate source responded with HTTP ${response.status}.`);

    const body = (await response.json()) as Record<string, Record<string, number | string> | undefined>;
    const raw = body[coinId]?.[fiat.toLowerCase()];
    const rate = raw === undefined ? new Decimal(NaN) : new Decimal(String(raw));
    if (!rate.isFinite() || rate.lte(0)) throw err.unavailable('rate_unavailable', `No valid ${asset}/${fiat} rate.`);

    const snapshot: RateSnapshot = { rate, source: this.source, fetchedAt: new Date(now) };
    this.cache.set(key, { snapshot, expiresAt: now + (this.options.cacheTtlMs ?? 10_000) });
    return snapshot;
  }
}

/** Sandbox rates: deterministic, derived from USD. Adjustable with setUsdPrice() to test rate movement. */
const SANDBOX_USD_PRICE: Record<AssetCode, string> = {
  USDC: '1.0000',
  USDT: '1.0000',
  ETH: '3150.00',
  POL: '0.2400',
  BTC: '95000.00',
};
const SANDBOX_FIAT_PER_USD: Record<FiatCurrency, string> = {
  USD: '1',
  EUR: '0.92',
  GBP: '0.79',
  CHF: '0.88',
  CAD: '1.37',
  AUD: '1.53',
  RSD: '100.50',
};

export class SandboxRateProvider implements RateProvider {
  readonly source = 'sandbox';
  private readonly usdPrice = new Map<AssetCode, Decimal>(
    (Object.keys(SANDBOX_USD_PRICE) as AssetCode[]).map((a) => [a, new Decimal(SANDBOX_USD_PRICE[a])]),
  );

  setUsdPrice(asset: AssetCode, usd: string): void {
    this.usdPrice.set(asset, new Decimal(usd));
  }

  async getRate(asset: AssetCode, fiat: FiatCurrency): Promise<RateSnapshot> {
    const usd = this.usdPrice.get(asset);
    if (!usd) throw err.unavailable('rate_unavailable', `No sandbox rate for ${asset}.`);
    return {
      rate: usd.mul(SANDBOX_FIAT_PER_USD[fiat]),
      source: this.source,
      fetchedAt: new Date(),
    };
  }
}
