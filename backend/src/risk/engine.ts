/**
 * Modular, explainable risk scoring. Every signal adds points with a reason string, so a
 * decision can always be audited. Thresholds are per merchant (see merchants.risk_thresholds).
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';

export interface RiskThresholds {
  medium: number;
  high: number;
  blocked: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = { medium: 30, high: 60, blocked: 100 };

export interface RiskSignals {
  amountMinor: bigint;
  highValueMinor: bigint;
  paymentsLastHourSameEmail: number;
  paymentsLastHourSameIp: number;
  failedLast24hSameEmail: number;
  disposableEmail: boolean;
  ipReputation: 'good' | 'unknown' | 'bad';
  processorRisk: 'normal' | 'elevated' | 'highest' | null;
  billingCountry: string | null;
  cardCountry: string | null;
  externalScore: number;
  externalReasons: string[];
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export function assessRisk(signals: RiskSignals, thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (signals.paymentsLastHourSameEmail >= 5) add(40, 'velocity_email_high');
  else if (signals.paymentsLastHourSameEmail >= 3) add(20, 'velocity_email_elevated');

  if (signals.paymentsLastHourSameIp >= 10) add(30, 'velocity_ip_high');

  if (signals.failedLast24hSameEmail >= 3) add(40, 'repeated_failed_payments');

  if (signals.amountMinor >= signals.highValueMinor * 5n) add(40, 'value_very_high');
  else if (signals.amountMinor >= signals.highValueMinor) add(20, 'value_high');

  if (signals.disposableEmail) add(15, 'disposable_email');

  if (signals.ipReputation === 'bad') add(60, 'ip_reputation_bad');

  if (signals.processorRisk === 'elevated') add(25, 'processor_risk_elevated');
  if (signals.processorRisk === 'highest') add(60, 'processor_risk_highest');

  if (signals.billingCountry && signals.cardCountry && signals.billingCountry !== signals.cardCountry) {
    add(25, 'billing_card_country_mismatch');
  }

  if (signals.externalScore > 0) {
    score += signals.externalScore;
    reasons.push(...signals.externalReasons.map((r) => `external:${r}`));
  }

  return { score, level: levelFor(score, thresholds), reasons };
}

export function levelFor(score: number, thresholds: RiskThresholds): RiskLevel {
  if (score >= thresholds.blocked) return 'BLOCKED';
  if (score >= thresholds.high) return 'HIGH';
  if (score >= thresholds.medium) return 'MEDIUM';
  return 'LOW';
}

const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com', 'yopmail.com']);

export function isDisposableEmail(email: string | null): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? DISPOSABLE_DOMAINS.has(domain) : false;
}
