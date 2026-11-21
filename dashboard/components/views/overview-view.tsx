'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useSession } from '@/components/session-provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Notice, LoadingBlock } from '@/components/ui/states';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { useApiData } from '@/lib/client/use-api-data';
import { formatAmount, formatDecimal, formatDuration, isoDay } from '@/lib/format';
import type { AnalyticsSummary } from '@/lib/types';
import { PageHeader } from '@/components/shell/brand';

type Preset = '7d' | '30d' | '90d' | 'custom';
const PRESET_DAYS: Record<Exclude<Preset, 'custom'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

function Kpi({ label, children, footnote }: { label: string; children: ReactNode; footnote?: string }) {
  return (
    <Card bodyClassName="space-y-2">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="space-y-1 text-2xl font-semibold tracking-tight break-words">{children}</div>
      {footnote && <p className="text-xs text-muted-foreground">{footnote}</p>}
    </Card>
  );
}

export function OverviewView() {
  const { mode } = useSession();
  const [preset, setPreset] = useState<Preset>('30d');
  const [customFrom, setCustomFrom] = useState(() => isoDay(new Date(Date.now() - 30 * 86_400_000)));
  const [customTo, setCustomTo] = useState(() => isoDay(new Date()));

  const range = useMemo(() => {
    if (preset === 'custom') return { from: `${customFrom}T00:00:00.000Z`, to: `${customTo}T23:59:59.999Z` };
    const end = new Date();
    const start = new Date(end.getTime() - PRESET_DAYS[preset] * 86_400_000);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [preset, customFrom, customTo]);

  const invalidCustom = preset === 'custom' && customFrom > customTo;
  const query = new URLSearchParams(range).toString();
  const { data, error, loading, reload } = useApiData<AnalyticsSummary>(
    invalidCustom ? null : `/api/v1/analytics/summary?${query}`,
    [mode, range.from, range.to],
  );

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Payments, settlements and refunds for ${mode === 'live' ? 'live' : 'test'} mode.`}
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label="Period"
              wrapperClassName="w-44"
              value={preset}
              onChange={(event) => setPreset(event.target.value as Preset)}
              options={[
                { value: '7d', label: 'Last 7 days' },
                { value: '30d', label: 'Last 30 days' },
                { value: '90d', label: 'Last 90 days' },
                { value: 'custom', label: 'Custom range' },
              ]}
            />
            {preset === 'custom' && (
              <>
                <TextField label="From" type="date" wrapperClassName="w-40" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
                <TextField label="To" type="date" wrapperClassName="w-40" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
              </>
            )}
          </div>
        }
      />

      {invalidCustom && <Notice tone="error">The start date must be before the end date.</Notice>}
      {error && (
        <div className="mb-4">
          <Notice tone="error" title="The summary could not be loaded.">
            {error.message}{' '}
            <Button variant="outline" size="sm" className="ml-2" onClick={reload}>
              Try again
            </Button>
          </Notice>
        </div>
      )}

      {!data && loading && (
        <Card>
          <LoadingBlock lines={4} label="Loading summary" />
        </Card>
      )}

      {data && (
        <div className="space-y-6" aria-busy={loading || undefined}>
          <p className="text-sm text-muted-foreground">
            Period: {new Date(data.period.from).toLocaleDateString('en-US', { dateStyle: 'medium' })} to{' '}
            {new Date(data.period.to).toLocaleDateString('en-US', { dateStyle: 'medium' })}
          </p>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Captured revenue" footnote="Payments captured by the provider, per currency.">
              {data.revenue.length === 0 ? (
                <span>0.00</span>
              ) : (
                data.revenue.map((row) => (
                  <div key={row.currency} className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span>{formatAmount(row.amount, row.currency)}</span>
                    <span className="text-xs font-normal text-muted-foreground">{row.captured_count} captured</span>
                  </div>
                ))
              )}
            </Kpi>
            <Kpi label="Paid orders" footnote="Orders with a captured payment.">
              <span>{data.orders.paid}</span>
            </Kpi>
            <Kpi label="Payments" footnote="Created in the period.">
              <span>{data.payments.total}</span>
              <p className="text-sm font-normal text-muted-foreground">
                {data.payments.failed} failed · {data.payments.cancelled} cancelled · {data.payments.open} open
              </p>
            </Kpi>
            <Kpi label="Settlements" footnote="Crypto settlements for payments created in the period.">
              <span>{data.settlements.completed} settled</span>
              <p className="text-sm font-normal text-muted-foreground">
                {data.settlements.pending} pending · {data.settlements.failed} failed · {data.settlements.on_hold} on hold
              </p>
              <p className="text-sm font-normal text-muted-foreground">
                Average {formatDuration(data.settlements.average_seconds_from_capture)} from capture
              </p>
            </Kpi>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Refunds" description="Successful refunds, with crypto recovery still owed.">
              {data.refunds.length === 0 ? (
                <p className="text-sm text-muted-foreground">No refunds in this period.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.refunds.map((row) => (
                    <li key={row.currency} className="space-y-1 py-3 first:pt-0 last:pb-0">
                      <p className="font-medium">
                        {formatAmount(row.amount, row.currency)} <span className="text-sm font-normal text-muted-foreground">in {row.count} refund{row.count === 1 ? '' : 's'}</span>
                      </p>
                      <p className="text-sm text-muted-foreground">Open crypto recovery: {formatAmount(row.open_crypto_recovery, row.currency)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Fees" description="Fee lines recorded on settlements.">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Payment</dt>
                <dd className="text-right font-medium tabular-nums">{formatDecimal(data.fees.payment)}</dd>
                <dt className="text-muted-foreground">Conversion</dt>
                <dd className="text-right font-medium tabular-nums">{formatDecimal(data.fees.conversion)}</dd>
                <dt className="text-muted-foreground">Platform</dt>
                <dd className="text-right font-medium tabular-nums">{formatDecimal(data.fees.platform)}</dd>
                <dt className="text-muted-foreground">Blockchain network</dt>
                <dd className="text-right font-medium tabular-nums">{formatDecimal(data.fees.blockchain_network)}</dd>
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">{data.fees.currency_note}</p>
            </Card>

            <Card title="Exchange rates" description="Latest rate used for each pair.">
              {data.exchange_rates.length === 0 ? (
                <p className="text-sm text-muted-foreground">No quotes in this mode yet.</p>
              ) : (
                <TableFrame label="Exchange rates">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Pair</Th>
                        <Th className="text-right">Rate</Th>
                        <Th>Source</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.exchange_rates.map((row) => (
                        <tr key={`${row.asset}-${row.fiat_currency}`}>
                          <Td className="whitespace-nowrap">
                            1 {row.asset} = {row.fiat_currency}
                          </Td>
                          <Td className="text-right font-mono text-xs tabular-nums">{formatDecimal(row.rate)}</Td>
                          <Td className="text-xs text-muted-foreground">{row.source}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableFrame>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
