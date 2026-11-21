import { SANDBOX_SANCTIONED_ADDRESS } from '../blockchain/sandbox.js';

/**
 * Compliance abstraction. Every provider is an interface so a jurisdiction-specific vendor can be
 * plugged in without touching the settlement engine. Live settlement is FAIL-CLOSED: if a required
 * provider is not configured, settlements are held, never released.
 */
export interface KycProvider {
  getMerchantStatus(merchantId: string): Promise<'APPROVED' | 'PENDING' | 'REJECTED'>;
}

export interface SanctionsProvider {
  screenAddress(input: { address: string; blockchain: string }): Promise<'clear' | 'hit' | 'review'>;
}

export interface AmlProvider {
  assessSettlement(input: {
    merchantId: string;
    address: string;
    blockchain: string;
    asset: string;
    amountMinor: bigint;
    currency: string;
    paymentId: string;
  }): Promise<'allow' | 'review' | 'block'>;
}

export interface FraudProvider {
  scoreCheckout(input: { merchantId: string; email: string | null; ipAddress: string | null }): Promise<{ score: number; reasons: string[] }>;
}

/** Explicit "no external fraud signal configured". Scores zero; the internal risk engine still runs. */
export class NoExternalFraudSignal implements FraudProvider {
  async scoreCheckout(): Promise<{ score: number; reasons: string[] }> {
    return { score: 0, reasons: [] };
  }
}

export interface ComplianceProviders {
  kyc: KycProvider;
  sanctions: SanctionsProvider | null;
  aml: AmlProvider | null;
}

export type ComplianceDecision = { allowed: true } | { allowed: false; holdReason: string };

export class ComplianceEngine {
  constructor(private readonly providers: ComplianceProviders) {}

  async checkSettlement(input: {
    merchantId: string;
    address: string;
    blockchain: string;
    asset: string;
    amountMinor: bigint;
    currency: string;
    paymentId: string;
  }): Promise<ComplianceDecision> {
    const kyb = await this.providers.kyc.getMerchantStatus(input.merchantId);
    if (kyb !== 'APPROVED') return hold('KYB_NOT_APPROVED');

    if (!this.providers.sanctions) return hold('COMPLIANCE_UNAVAILABLE:SANCTIONS');
    const screening = await this.providers.sanctions.screenAddress({ address: input.address, blockchain: input.blockchain });
    if (screening === 'hit') return hold('SANCTIONS_HIT');
    if (screening === 'review') return hold('SANCTIONS_REVIEW');

    if (!this.providers.aml) return hold('COMPLIANCE_UNAVAILABLE:AML');
    const decision = await this.providers.aml.assessSettlement(input);
    if (decision === 'block') return hold('AML_BLOCK');
    if (decision === 'review') return hold('AML_REVIEW');

    return { allowed: true };
  }
}

function hold(reason: string): ComplianceDecision {
  return { allowed: false, holdReason: reason };
}

/** Sandbox providers: approve everything except the designated sanctioned test address. */
export function sandboxComplianceProviders(): ComplianceProviders {
  return {
    kyc: { getMerchantStatus: async () => 'APPROVED' },
    sanctions: {
      screenAddress: async ({ address }) => (address.toLowerCase() === SANDBOX_SANCTIONED_ADDRESS.toLowerCase() ? 'hit' : 'clear'),
    },
    aml: { assessSettlement: async () => 'allow' },
  };
}
