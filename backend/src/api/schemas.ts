import { z } from 'zod';
import { FIAT_CURRENCIES } from '../core/money.js';
import { REFUND_REASONS } from '../payment-engine/service.js';
import { WEBHOOK_EVENT_TYPES } from '../webhooks/outbound.js';

const decimalAmount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'amount must be a decimal string with at most 2 decimals');
const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL');

export const registerBody = z
  .object({
    merchant_name: z.string().trim().min(1).max(120),
    email: z.email().max(254),
    password: z.string().min(12).max(200),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
  })
  .strict();

export const loginBody = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(200),
    totp_code: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

export const refreshBody = z.object({ refresh_token: z.string().min(20).max(200) }).strict();
export const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

export const apiKeyBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    mode: z.enum(['test', 'live']).default('test'),
  })
  .strict();

export const rotateBody = z.object({ grace_hours: z.number().int().min(0).max(168).default(24) }).strict();

export const storeBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    platform: z.enum(['shopify', 'woocommerce', 'magento', 'prestashop', 'bigcommerce', 'custom', 'headless']),
    domain: z.string().max(255).optional(),
  })
  .strict();

export const walletBody = z
  .object({
    blockchain: z.string().min(2).max(32),
    asset: z.string().min(2).max(16),
    address: z.string().min(10).max(128),
  })
  .strict();

export const walletVerifyBody = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{100,2000}$/) }).strict();

export const quoteBody = z
  .object({
    amount: decimalAmount,
    currency: z.enum(FIAT_CURRENCIES),
    asset: z.string().min(2).max(16),
    blockchain: z.string().min(2).max(32),
    wallet_id: z.string().max(64).optional(),
  })
  .strict();

export const paymentBody = z
  .object({
    amount: decimalAmount,
    currency: z.enum(FIAT_CURRENCIES),
    order_id: z.string().min(1).max(128),
    customer: z.object({ email: z.email().max(254).optional() }).strict().optional(),
    description: z.string().max(250).optional(),
    return_url: httpUrl,
    cancel_url: httpUrl.optional(),
    metadata: z
      .record(z.string().min(1).max(40), z.string().max(500))
      .refine((m) => Object.keys(m).length <= 20, 'at most 20 metadata keys')
      .optional(),
    store_id: z.string().max(64).optional(),
    settlement: z
      .object({
        wallet_id: z.string().max(64).optional(),
        blockchain: z.string().min(2).max(32).optional(),
        asset: z.string().min(2).max(16).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const refundBody = z
  .object({
    amount: decimalAmount.optional(),
    reason: z.enum(REFUND_REASONS).default('requested_by_customer'),
  })
  .strict();

export const webhookEndpointBody = z
  .object({
    url: httpUrl,
    events: z.array(z.enum([...WEBHOOK_EVENT_TYPES, '*'] as [string, ...string[]])).min(1).max(20),
  })
  .strict();

export const adminStatusBody = z.object({ status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']) }).strict();

export const adminKybBody = z
  .object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    live_enabled: z.boolean().optional(),
  })
  .strict();

export const adminFlagBody = z
  .object({
    key: z.string().regex(/^[a-z0-9:_.-]{1,100}$/),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();

export const adminFeesBody = z
  .object({
    fee_schedule: z
      .object({
        paymentFeeBps: z.number().int().min(0).max(1000),
        paymentFeeFixedMinor: z.number().int().min(0).max(100000),
        conversionFeeBps: z.number().int().min(0).max(1000),
        platformFeeBps: z.number().int().min(0).max(1000),
      })
      .strict()
      .nullable(),
    max_rate_deviation_bps: z.number().int().min(0).max(1000).optional(),
    settlement_review_threshold_minor: z.number().int().positive().optional(),
  })
  .strict();
