'use client';

import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSession } from '@/components/session-provider';
import { PageHeader } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge, ModeBadge } from '@/components/ui/badge';
import { SelectField, TextField } from '@/components/ui/field';
import { Icon } from '@/components/ui/icons';
import { LoadingBlock, Notice } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { apiFetch, messageOf, newIdempotencyKey } from '@/lib/client/api';
import { useApiData } from '@/lib/client/use-api-data';
import { REFUND_REASONS } from '@/lib/constants';
import { explorerName, explorerTxUrl, formatAmount, formatDateTime, formatDecimal, formatMinorUnits, humanize, truncateMiddle } from '@/lib/format';
import type { PaymentDetail, Refund, SettlementDetail } from '@/lib/types';

const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;
const REFUNDABLE = new Set(['SETTLED', 'PARTIALLY_REFUNDED']);
const OPEN_CHECKOUT = new Set(['CREATED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED']);

const FEE_LINES: ReadonlyArray<[key: string, label: string]> = [
  ['grossMinor', 'Gross amount'],
  ['paymentFeeMinor', 'Payment fee'],
  ['conversionFeeMinor', 'Conversion fee'],
  ['platformFeeMinor', 'Platform fee'],
  ['networkFeeMinor', 'Network fee'],
  ['totalFeeMinor', 'Total fees'],
  ['merchantNetMinor', 'Merchant net'],
];

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function PaymentView({ id }: { id: string }) {
  const { mode } = useSession();
  const { notify } = useToast();
  const payment = useApiData<PaymentDetail>(`/api/v1/payments/${encodeURIComponent(id)}`, [mode]);
  const settlement = useApiData<SettlementDetail>(`/api/v1/payments/${encodeURIComponent(id)}/settlement`, [mode]);

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<string>('requested_by_customer');
  const [refunding, setRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refund, setRefund] = useState<Refund | null>(null);

  if (payment.error && !payment.data) {
    return (
      <>
        <PageHeader title="Payment" />
        <Notice tone="error" title="This payment could not be loaded.">
          {payment.error.message}
        </Notice>
      </>
    );
  }

  const p = payment.data;
  const s = settlement.data;

  /** The settlement row can lack its asset; the payment carries the same value. */
  const asset = s?.asset || p?.settlement.asset || '';

  async function submitRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRefundError(null);
    const trimmed = amount.trim();
    if (trimmed && !AMOUNT.test(trimmed)) {
      setRefundError('Enter an amount with at most two decimals, such as 30.00. Leave it empty to refund the remaining balance.');
      return;
    }
    setRefunding(true);
    try {
      // A fresh key per submit. A double click is blocked by the disabled button while the request runs.
      const created = await apiFetch<Refund>(`/api/v1/payments/${encodeURIComponent(id)}/refund`, {
        method: 'POST',
        body: { reason, ...(trimmed ? { amount: trimmed } : {}) },
        idempotencyKey: newIdempotencyKey(),
      });
      setRefund(created);
      setAmount('');
      notify({ tone: 'success', title: 'Refund created', description: `${formatAmount(created.amount, created.currency)} is ${humanize(created.status).toLowerCase()}.` });
      payment.reload();
      settlement.reload();
    } catch (error) {
      setRefundError(messageOf(error, 'The refund could not be created.'));
    } finally {
      setRefunding(false);
    }
  }

  const explorer = s ? explorerTxUrl(s.blockchain, s.transaction_hash) : null;
  const canRefund = p ? REFUNDABLE.has(p.status) : false;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted-foreground">
        <Link href="/transactions" className="inline-flex items-center gap-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded">
          <Icon name="back" className="size-3.5" />
          Transactions
        </Link>
      </nav>

      {!p ? (
        <Card>
          <LoadingBlock lines={5} label="Loading payment" />
        </Card>
      ) : (
        <>
          <PageHeader
            title="Payment"
            description={`${p.id} · created ${formatDateTime(p.created_at)}`}
            actions={
              <>
                <StatusBadge status={p.status} />
                <ModeBadge mode={p.mode} />
              </>
            }
          />

          <div className="grid min-w-0 gap-6 lg:grid-cols-3">
            <div className="min-w-0 space-y-6 lg:col-span-2">
              <Card title="Payment" description="What the customer paid and what happened to it.">
                <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                  <Item label="Order reference">{p.order_id}</Item>
                  <Item label="Amount">
                    <span className="text-lg font-semibold tabular-nums">{formatAmount(p.amount, p.currency)}</span>
                  </Item>
                  <Item label="Refunded">
                    <span className="tabular-nums">{formatAmount(p.refunded_amount, p.currency)}</span>
                  </Item>
                  <Item label="Payment method">{humanize(p.payment_method)}</Item>
                  <Item label="Customer email">{p.customer.email ?? '—'}</Item>
                  <Item label="Description">{p.description || '—'}</Item>
                  <Item label="Captured">{formatDateTime(p.captured_at)}</Item>
                  <Item label="Expires">{formatDateTime(p.expires_at)}</Item>
                  <Item label="Risk level">{p.risk_level ? humanize(p.risk_level) : '—'}</Item>
                  {p.hold_reason && <Item label="Hold reason">{humanize(p.hold_reason)}</Item>}
                  {p.failure_reason && <Item label="Failure reason">{humanize(p.failure_reason)}</Item>}
                  {Object.keys(p.metadata ?? {}).length > 0 && (
                    <div className="sm:col-span-2">
                      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Metadata</dt>
                      <dd className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                        {Object.entries(p.metadata).map(([key, value]) => (
                          <span key={key} className="min-w-0 break-words">
                            <span className="font-mono text-xs text-muted-foreground">{key}</span>: {value}
                          </span>
                        ))}
                      </dd>
                    </div>
                  )}
                </dl>
                {OPEN_CHECKOUT.has(p.status) && (
                  <div className="mt-5 border-t border-border pt-4">
                    <a href={p.checkout_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
                      Open hosted checkout (new tab)
                      <Icon name="external" className="size-3.5" />
                    </a>
                  </div>
                )}
              </Card>

              <Card title="Settlement" description="How the payment was converted and sent to your wallet.">
                {settlement.error && (
                  <Notice tone="error" title="Settlement details could not be loaded.">
                    {settlement.error.message}
                  </Notice>
                )}
                {!s && !settlement.error && <LoadingBlock lines={4} label="Loading settlement" />}
                {s && s.status === 'NOT_CREATED' && (
                  <p className="text-sm text-muted-foreground">No settlement yet. It starts after the card payment is captured.</p>
                )}
                {s && s.status !== 'NOT_CREATED' && (
                  <div className="space-y-6">
                    {s.last_error && (
                      <Notice tone="error" title="The settlement reported an error">
                        {s.last_error}
                      </Notice>
                    )}
                    {s.hold && (
                      <Notice tone="warning" title="Settlement on hold">
                        {s.hold_reason ? humanize(s.hold_reason) : 'A reviewer must release this settlement.'}
                      </Notice>
                    )}
                    <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                      <Item label="Status">
                        <StatusBadge status={s.status} />
                      </Item>
                      <Item label="Network">
                        {s.blockchain ? `${humanize(s.blockchain)} · ${asset}` : '—'}
                      </Item>
                      <Item label="Wallet">
                        <code className="font-mono text-xs break-all" title={s.wallet_address ?? undefined}>
                          {s.wallet_address ?? '—'}
                        </code>
                      </Item>
                      <Item label="Exchange rate">
                        {s.exchange_rate ? (
                          <span className="tabular-nums">
                            1 {asset || 'crypto'} = {formatDecimal(s.exchange_rate.slice(0, 12))} {p.currency}
                          </span>
                        ) : (
                          '—'
                        )}
                        {s.rate_source && <span className="block text-xs text-muted-foreground">Source: {s.rate_source}</span>}
                      </Item>
                      <Item label="Crypto amount">
                        <span className="tabular-nums">{s.crypto_amount ? `${formatDecimal(s.crypto_amount)} ${asset}` : '—'}</span>
                      </Item>
                      <Item label="Merchant received">
                        <span className="tabular-nums">{s.merchant_received ? `${formatDecimal(s.merchant_received)} ${asset}` : '—'}</span>
                      </Item>
                      <Item label="Network fee">{formatAmount(s.network_fee, p.currency)}</Item>
                      <Item label="Confirmations">
                        {s.confirmations !== undefined ? `${s.confirmations} of ${s.required_confirmations ?? '?'}` : '—'}
                      </Item>
                      <Item label="Transaction">
                        {explorer && s.transaction_hash ? (
                          <a href={explorer} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs break-all text-primary underline-offset-4 hover:underline" aria-label={`${s.transaction_hash} on ${explorerName(s.blockchain)} (opens in a new tab)`}>
                            {truncateMiddle(s.transaction_hash, 14, 10)}
                            <Icon name="external" className="size-3" />
                          </a>
                        ) : s.transaction_hash ? (
                          <code className="font-mono text-xs break-all">{s.transaction_hash}</code>
                        ) : (
                          'Not broadcast yet'
                        )}
                      </Item>
                      <Item label="Confirmed">{formatDateTime(s.confirmed_at ?? null)}</Item>
                    </dl>

                    <div>
                      <h3 className="mb-3 text-sm font-semibold">Fee breakdown ({p.currency})</h3>
                      <dl className="divide-y divide-border rounded-lg border border-border text-sm">
                        {FEE_LINES.map(([key, label]) => (
                          <div key={key} className="flex items-center justify-between gap-4 px-4 py-2.5">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="font-medium tabular-nums">{formatMinorUnits(s.fees?.[key] ?? null)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </div>
                )}
              </Card>
            </div>

            <div className="min-w-0 space-y-6">
              <Card title="Refund" description="Returns money to the card. Crypto that was already settled is not reversed automatically.">
                {!canRefund ? (
                  <Notice tone="info">Refunds become available once the crypto settlement is confirmed.</Notice>
                ) : (
                  <form onSubmit={submitRefund} noValidate className="space-y-5">
                    {refundError && <Notice tone="error">{refundError}</Notice>}
                    <TextField
                      label="Amount"
                      name="refund_amount"
                      inputMode="decimal"
                      placeholder={`Leave empty for the remaining balance`}
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      hint={`Currency ${p.currency}. Already refunded: ${formatAmount(p.refunded_amount, p.currency)}.`}
                    />
                    <SelectField label="Reason" name="reason" value={reason} onChange={(event) => setReason(event.target.value)} options={REFUND_REASONS} />
                    <Button type="submit" variant="danger" block loading={refunding}>
                      Refund payment
                    </Button>
                  </form>
                )}

                {refund && (
                  <div className="mt-5 space-y-3 border-t border-border pt-5">
                    <Notice tone="success" title={`Refund ${humanize(refund.status)}: ${formatAmount(refund.amount, refund.currency)}`}>
                      Reference {refund.id}
                    </Notice>
                    <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
                      <p className="font-medium">Crypto recovery: {refund.crypto_recovery.status ? humanize(refund.crypto_recovery.status) : '—'}</p>
                      <p className="mt-1 text-muted-foreground">{refund.crypto_recovery.note}</p>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
