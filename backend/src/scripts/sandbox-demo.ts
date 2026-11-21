/**
 * End-to-end sandbox walkthrough over real HTTP against a running API and worker.
 * Usage: API_URL=http://localhost:3000 npm run demo -w @cardcrypto/backend
 * Creates a fresh merchant each run. Moves no real money.
 */
import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const api = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

async function call(method: string, path: string, token: string | undefined, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, json: text && text.startsWith('{') ? JSON.parse(text) : text, headers: res.headers };
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function step(label: string, value: unknown) {
  console.log(`${label.padEnd(34)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const email = `demo-${randomUUID().slice(0, 8)}@shop.test`;
  const reg = await call('POST', '/v1/auth/register', undefined, { merchant_name: 'Demo Shop', email, password: 'demo passphrase 2026' });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.json)}`);
  step('1. merchant registered', email);

  const key = await call('POST', '/v1/api-keys', reg.json.access_token, { name: 'demo', mode: 'test' });
  const sk = key.json.secret as string;
  step('2. test API key issued', `${sk.slice(0, 12)}…`);

  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = await call('POST', '/v1/wallet', sk, { blockchain: 'polygon', asset: 'USDC', address: account.address });
  const signature = await account.signMessage({ message: wallet.json.verification.message });
  const verified = await call('POST', `/v1/wallet/${wallet.json.id}/verify`, sk, { signature });
  await call('POST', `/v1/wallet/${wallet.json.id}/default`, sk);
  step('3. wallet verified by signature', `${verified.json.address} (${verified.json.status})`);

  const payment = await call('POST', '/v1/payments', sk,
    { amount: '100.00', currency: 'EUR', order_id: `DEMO-${randomUUID().slice(0, 6)}`, customer: { email: 'buyer@example.com' }, return_url: 'https://shop.test/thanks' },
    { 'idempotency-key': `demo-${randomUUID()}` });
  if (payment.status !== 201) throw new Error(`payment failed: ${JSON.stringify(payment.json)}`);
  step('4. payment created', { id: payment.json.id, status: payment.json.status, amount: payment.json.amount });

  const checkout = new URL(payment.json.checkout_url);
  const form = await fetch(`${api}/checkout/sandbox/${payment.json.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: checkout.searchParams.get('t') ?? '', outcome: 'success' }),
    redirect: 'manual',
  });
  step('5. shopper paid (test card 4242…)', `HTTP ${form.status}`);

  const paymentId = payment.json.id as string;
  let status = '';
  await waitFor(async () => {
    status = (await call('GET', `/v1/payments/${paymentId}`, sk)).json.status;
    return status === 'SETTLED';
  }, 'settlement');
  step('6. settled on-chain', status);

  const settlement = await call('GET', `/v1/payments/${paymentId}/settlement`, sk);
  step('7. settlement', {
    merchant_received: `${settlement.json.merchant_received} USDC`,
    rate: settlement.json.exchange_rate,
    network_fee: settlement.json.network_fee,
    transaction_hash: settlement.json.transaction_hash,
    confirmations: settlement.json.confirmations,
  });

  const refund = await call('POST', `/v1/payments/${paymentId}/refund`, sk, { amount: '25.00', reason: 'requested_by_customer' }, { 'idempotency-key': `refund-${randomUUID()}` });
  step('8. partial refund 25.00 EUR', { status: refund.json.status, crypto_recovery: refund.json.crypto_recovery?.status });

  const final = await call('GET', `/v1/payments/${paymentId}`, sk);
  step('9. payment after refund', { status: final.json.status, refunded: final.json.refunded_amount });

  const ledger = await call('GET', '/v1/transactions?limit=5', sk);
  step('10. ledger rows', ledger.json.data.length);
}

main().catch((error) => {
  console.error('demo failed:', (error as Error).message);
  process.exit(1);
});
