/**
 * Asset and blockchain registry. Adding an asset or chain means adding an entry here
 * plus (for a new chain family) a BlockchainAdapter. Nothing else is hardcoded.
 */

export type AssetCode = 'USDC' | 'USDT' | 'ETH' | 'POL' | 'BTC';

export interface AssetDef {
  code: AssetCode;
  name: string;
  decimals: number;
  /** CoinGecko id used by the live rate provider. */
  coingeckoId: string;
}

export const ASSETS: Record<AssetCode, AssetDef> = {
  USDC: { code: 'USDC', name: 'USD Coin', decimals: 6, coingeckoId: 'usd-coin' },
  USDT: { code: 'USDT', name: 'Tether', decimals: 6, coingeckoId: 'tether' },
  ETH: { code: 'ETH', name: 'Ether', decimals: 18, coingeckoId: 'ethereum' },
  POL: { code: 'POL', name: 'Polygon POL', decimals: 18, coingeckoId: 'polygon-ecosystem-token' },
  BTC: { code: 'BTC', name: 'Bitcoin', decimals: 8, coingeckoId: 'bitcoin' },
};

export function isAssetCode(value: string): value is AssetCode {
  return Object.prototype.hasOwnProperty.call(ASSETS, value);
}

export type ChainKey = 'ethereum' | 'polygon' | 'base' | 'arbitrum';

export interface ChainDef {
  key: ChainKey;
  name: string;
  chainId: number;
  family: 'evm';
  gasToken: AssetCode;
  /** Conservative default; overridable per deployment via config. */
  defaultConfirmations: number;
  pollIntervalMs: number;
  /** Token contracts for stablecoins settled on this chain (verified via checksum test). */
  tokens: Partial<Record<AssetCode, `0x${string}`>>;
}

export const CHAINS: Record<ChainKey, ChainDef> = {
  ethereum: {
    key: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    family: 'evm',
    gasToken: 'ETH',
    defaultConfirmations: 12,
    pollIntervalMs: 12_000,
    tokens: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    },
  },
  polygon: {
    key: 'polygon',
    name: 'Polygon PoS',
    chainId: 137,
    family: 'evm',
    gasToken: 'POL',
    defaultConfirmations: 128,
    pollIntervalMs: 4_000,
    tokens: {
      USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    },
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    family: 'evm',
    gasToken: 'ETH',
    defaultConfirmations: 10,
    pollIntervalMs: 2_000,
    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    family: 'evm',
    gasToken: 'ETH',
    defaultConfirmations: 10,
    pollIntervalMs: 2_000,
    tokens: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    },
  },
};

export function isChainKey(value: string): value is ChainKey {
  return Object.prototype.hasOwnProperty.call(CHAINS, value);
}
