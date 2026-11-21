import type { AppConfig } from './config.js';
import { AppError } from './core/errors.js';
import type { ChainKey } from './core/assets.js';
import type { Mode } from './core/types.js';
import { CHAINS } from './core/assets.js';
import { SandboxChainAdapter, SANDBOX_SANCTIONED_ADDRESS } from './blockchain/sandbox.js';
import { EvmBlockchainAdapter } from './blockchain/evm.js';
import { envPrivateKeySigner } from './blockchain/signers.js';
import type { BlockchainAdapter } from './blockchain/types.js';
import { ComplianceEngine, NoExternalFraudSignal, sandboxComplianceProviders, type FraudProvider } from './compliance/index.js';
import { createPool, type Db } from './db/pool.js';
import { CoinGeckoRateProvider, SandboxRateProvider, type RateProvider } from './crypto-engine/rates.js';
import { QuoteService } from './crypto-engine/quotes.js';
import { PaymentService } from './payment-engine/service.js';
import type { PaymentProvider } from './payment-processors/types.js';
import { SandboxPaymentProvider } from './payment-processors/sandbox.js';
import { StripePaymentProvider } from './payment-processors/stripe.js';
import { SettlementService } from './settlement/service.js';
import { MerchantService } from './merchant/service.js';
import { WalletService } from './wallet/service.js';
import { WebhookService } from './webhooks/service.js';
import { AnalyticsService } from './analytics/service.js';

/** Wiring for the whole application. Mode decides which adapters serve a request: test = sandbox, live = real. */
export interface Container {
  config: AppConfig;
  db: Db;
  merchants: MerchantService;
  wallets: WalletService;
  payments: PaymentService;
  settlements: SettlementService;
  webhooks: WebhookService;
  analytics: AnalyticsService;
  quotes: QuoteService;
  sandboxProvider: SandboxPaymentProvider;
  providerFor(mode: Mode): PaymentProvider;
  chainFor(mode: Mode, chain: ChainKey): BlockchainAdapter | null;
  chainActive(mode: Mode, chain: ChainKey): Promise<boolean>;
  ratesFor(mode: Mode): RateProvider;
  complianceFor(mode: Mode): ComplianceEngine;
  fraudFor(mode: Mode): FraudProvider;
  liveConfigured: boolean;
}

export function buildContainer(config: AppConfig, db: Db = createPool(config.databaseUrl)): Container {
  const sandboxChains = new Map<ChainKey, SandboxChainAdapter>();
  const liveChains = new Map<ChainKey, EvmBlockchainAdapter>();
  const sandboxRates = new SandboxRateProvider();
  const liveRates = new CoinGeckoRateProvider({ baseUrl: config.coingecko.baseUrl, apiKey: config.coingecko.apiKey });
  const sandboxProvider = new SandboxPaymentProvider({ publicBaseUrl: config.publicBaseUrl, secret: config.sandboxWebhookSecret });
  const liveProvider = config.stripe
    ? new StripePaymentProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret })
    : null;
  const signer = config.treasuryPrivateKey ? envPrivateKeySigner(config.treasuryPrivateKey) : null;

  const chainFor = (mode: Mode, chain: ChainKey): BlockchainAdapter | null => {
    if (mode === 'test') {
      let adapter = sandboxChains.get(chain);
      if (!adapter) {
        adapter = new SandboxChainAdapter({
          chainKey: chain,
          secret: config.sandboxWebhookSecret,
          requiredConfirmations: 3,
          blockTimeMs: config.sandboxBlockTimeMs,
          inclusionDelayMs: config.sandboxInclusionDelayMs,
        });
        sandboxChains.set(chain, adapter);
      }
      return adapter;
    }
    if (!config.liveModeEnabled || !signer || !config.rpcUrls[chain]) return null;
    let adapter = liveChains.get(chain);
    if (!adapter) {
      adapter = new EvmBlockchainAdapter({
        chainKey: chain,
        mode: 'live',
        signer,
        rpcUrls: config.rpcUrls[chain],
        requiredConfirmations: config.confirmations[chain] ?? CHAINS[chain].defaultConfirmations,
      });
      liveChains.set(chain, adapter);
    }
    return adapter;
  };

  const liveCompliance = new ComplianceEngine({
    kyc: {
      getMerchantStatus: async (merchantId: string) => {
        const { rows } = await db.query('SELECT kyb_status FROM merchants WHERE id = $1', [merchantId]);
        return (rows[0]?.kyb_status ?? 'PENDING') as 'APPROVED' | 'PENDING' | 'REJECTED';
      },
    },
    // Fail-closed: without configured sanctions and AML providers, live settlements are held.
    sanctions: null,
    aml: null,
  });
  const sandboxCompliance = new ComplianceEngine(sandboxComplianceProviders());
  const complianceFor = (mode: Mode) => (mode === 'test' ? sandboxCompliance : liveCompliance);

  const providerFor = (mode: Mode): PaymentProvider => {
    if (mode === 'test') return sandboxProvider;
    if (!liveProvider) throw new AppError(503, 'provider_unavailable', 'Live card payments are not configured on this deployment.');
    return liveProvider;
  };

  const ratesFor = (mode: Mode): RateProvider => (mode === 'test' ? sandboxRates : liveRates);

  const chainActive = async (mode: Mode, chain: ChainKey): Promise<boolean> => {
    if (!chainFor(mode, chain)) return false;
    const flag = await db.query<{ value: { disabled?: boolean } }>('SELECT value FROM platform_flags WHERE key = $1', [`chain:${chain}`]);
    return flag.rows[0]?.value?.disabled !== true;
  };

  const quotes = new QuoteService({ ratesFor, adapterFor: chainFor, defaultFees: config.fees });
  const merchants = new MerchantService({ db, config });
  const wallets = new WalletService({
    db,
    activationDelayHours: config.walletActivationDelayHours,
    adapterFor: (chain) => {
      const adapter = chainFor('test', chain);
      if (!adapter) throw new AppError(500, 'internal', `No adapter for ${chain}.`);
      return adapter;
    },
    // Adding a wallet only blocks on a confirmed hit. Settlement itself is gated by ComplianceEngine.
    screenAddress: async (address) => (address.toLowerCase() === SANDBOX_SANCTIONED_ADDRESS.toLowerCase() ? 'hit' : 'clear'),
  });
  const payments = new PaymentService({
    db,
    config,
    providerFor,
    fraudFor: () => new NoExternalFraudSignal(),
    wallets,
    chainActive,
  });
  const settlements = new SettlementService({ db, config, chainFor, complianceFor, quotes });
  const webhooks = new WebhookService({ db, config });
  const analytics = new AnalyticsService(db);

  return {
    config,
    db,
    merchants,
    wallets,
    payments,
    settlements,
    webhooks,
    analytics,
    quotes,
    sandboxProvider,
    providerFor,
    chainFor,
    chainActive,
    ratesFor,
    complianceFor,
    fraudFor: () => new NoExternalFraudSignal(),
    liveConfigured: Boolean(liveProvider && signer && config.liveModeEnabled),
  };
}
