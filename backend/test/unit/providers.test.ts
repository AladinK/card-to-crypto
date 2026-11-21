import Stripe from 'stripe';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { validateEvmAddress, verifyEvmWalletSignature } from '../../src/blockchain/evm.js';
import { SandboxChainAdapter } from '../../src/blockchain/sandbox.js';
import { StripePaymentProvider } from '../../src/payment-processors/stripe.js';
import { SandboxPaymentProvider, SANDBOX_CARD_SIGNATURE_HEADER } from '../../src/payment-processors/sandbox.js';
import { hmacHex } from '../../src/core/security.js';

describe('wallet ownership', () => {
  it('accepts a signature made by the wallet and rejects another wallet', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const message = 'CardCrypto wallet verification\nNonce: abc';
    const signature = await owner.signMessage({ message });
    expect(await verifyEvmWalletSignature({ address: owner.address, message, signature })).toBe(true);
    expect(await verifyEvmWalletSignature({ address: other.address, message, signature })).toBe(false);
    expect(await verifyEvmWalletSignature({ address: owner.address, message: 'tampered', signature })).toBe(false);
  });
});

describe('EVM address validation', () => {
  it('normalizes valid addresses and rejects a wrong checksum', () => {
    const lower = '0x52908400098527886e0f7030069857d2e4169ee7';
    expect(validateEvmAddress(lower)).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
    expect(validateEvmAddress('0x52908400098527886E0F7030069857D2E4169EE8')).toBeNull(); // mangled checksum
    expect(validateEvmAddress('not-an-address')).toBeNull();
  });
});

describe('Stripe adapter', () => {
  const secret = 'whsec_test_123';
  const provider = new StripePaymentProvider({ secretKey: 'sk_test_123', webhookSecret: secret });
  const client = new Stripe('sk_test_123');

  const sign = (event: object) => {
    const payload = JSON.stringify(event);
    return { payload: Buffer.from(payload), header: client.webhooks.generateTestHeaderString({ payload, secret }) };
  };

  it('maps a manual-capture authorization to payment.authorized with the payment id from metadata', () => {
    const { payload, header } = sign({
      id: 'evt_auth_1',
      object: 'event',
      type: 'payment_intent.amount_capturable_updated',
      data: {
        object: {
          id: 'pi_1',
          object: 'payment_intent',
          status: 'requires_capture',
          amount: 10000,
          currency: 'eur',
          metadata: { payment_id: 'pay_abc' },
        },
      },
    });
    const [event] = provider.handleWebhook(payload, { 'stripe-signature': header });
    expect(event).toMatchObject({ kind: 'payment.authorized', eventId: 'evt_auth_1', paymentId: 'pay_abc', providerPaymentId: 'pi_1', amountMinor: 10000n, currency: 'EUR' });
  });

  it('maps refund updates and ignores unrelated events', () => {
    const refund = sign({
      id: 'evt_ref_1',
      object: 'event',
      type: 'refund.updated',
      data: { object: { id: 're_1', object: 'refund', status: 'succeeded', amount: 3000, currency: 'eur', payment_intent: 'pi_1', metadata: { refund_id: 'ref_1' } } },
    });
    const [event] = provider.handleWebhook(refund.payload, { 'stripe-signature': refund.header });
    expect(event).toMatchObject({ kind: 'refund.succeeded', refundId: 'ref_1', providerRefundId: 're_1', amountMinor: 3000n });

    const other = sign({ id: 'evt_other', object: 'event', type: 'customer.created', data: { object: { id: 'cus_1', object: 'customer' } } });
    expect(provider.handleWebhook(other.payload, { 'stripe-signature': other.header })[0]?.kind).toBe('ignored');
  });

  it('rejects requests with a forged or missing signature', () => {
    const { payload } = sign({ id: 'evt_x', object: 'event', type: 'payment_intent.succeeded', data: { object: {} } });
    expect(() => provider.handleWebhook(payload, { 'stripe-signature': 't=1,v1=deadbeef' })).toThrow();
    expect(() => provider.handleWebhook(payload, {})).toThrow(AppError);
  });
});

describe('sandbox provider', () => {
  const sandbox = new SandboxPaymentProvider({ publicBaseUrl: 'http://localhost:3000', secret: 'sandbox-secret-value-123456789' });

  it('issues checkout links bound to the payment id by an HMAC token', () => {
    const token = sandbox.checkoutToken('pay_1');
    expect(sandbox.verifyCheckoutToken('pay_1', token)).toBe(true);
    expect(sandbox.verifyCheckoutToken('pay_2', token)).toBe(false);
    expect(sandbox.verifyCheckoutToken('pay_1', undefined)).toBe(false);
  });

  it('accepts only simulator events signed with the sandbox secret', () => {
    const body = JSON.stringify({ kind: 'payment.failed', eventId: 'e1', paymentId: 'pay_1', reason: 'card_declined' });
    const good = Buffer.from(body);
    expect(sandbox.handleWebhook(good, { [SANDBOX_CARD_SIGNATURE_HEADER]: hmacHex('sandbox-secret-value-123456789', body) })[0]?.kind).toBe('payment.failed');
    expect(() => sandbox.handleWebhook(good, { [SANDBOX_CARD_SIGNATURE_HEADER]: 'bad' })).toThrow(AppError);
  });
});

describe('sandbox chain adapter', () => {
  it('simulates inclusion and confirmations without moving money', async () => {
    let now = 1_000;
    const chain = new SandboxChainAdapter({ chainKey: 'polygon', secret: 'sandbox-secret-value-123456789', requiredConfirmations: 3, blockTimeMs: 100, inclusionDelayMs: 200, now: () => now });
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const fee = await chain.estimateFee();
    const prepared = chain.prepareTransfer({ from: chain.treasury.address, to, asset: 'USDC', amountBaseUnits: 1_000_000n, nonce: 0n, fee });
    const signed = chain.finalizeTransfer(prepared, await chain.treasury.sign(prepared.digest));
    await chain.broadcastTransaction(signed.raw);

    expect(await chain.getTransactionStatus(signed.txHash)).toBe('pending');
    now += 250;
    expect(await chain.getTransactionStatus(signed.txHash)).toBe('success');
    expect(await chain.getConfirmationCount(signed.txHash)).toBe(1);
    now += 1_000;
    expect(await chain.getConfirmationCount(signed.txHash)).toBe(3);
    expect(await chain.verifyTransferEvent({ txHash: signed.txHash, asset: 'USDC', to, amountBaseUnits: 1_000_000n })).toBe(true);
    expect(await chain.verifyTransferEvent({ txHash: signed.txHash, asset: 'USDC', to, amountBaseUnits: 999_999n })).toBe(false);
  });
});
