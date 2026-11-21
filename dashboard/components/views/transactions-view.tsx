'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type MouseEvent } from 'react';
import { useSession } from '@/components/session-provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { SelectField, TextField } from '@/components/ui/field';
import { Icon } from '@/components/ui/icons';
import { EmptyState, LoadingBlock, Notice } from '@/components/ui/states';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { CHAIN_BY_KEY } from '@/lib/constants';
import { explorerName, explorerTxUrl, formatAmount, formatDateTime, formatDecimal, humanize, truncateMiddle } from '@/lib/format';
import { useApiData } from '@/lib/client/use-api-data';
import type { TransactionRow } from '@/lib/types';
import { PageHeader } from '@/components/shell/brand';

const PAGE_SIZES = [25, 50, 100] as const;

/** Trims long crypto rates for display only (no rounding arithmetic). */
const shortRate = (value: string | null): string => {
  if (!value) return '—';
  const [whole, fraction] = value.split('.');
  return fraction === undefined ? value : `${whole}.${fraction.slice(0, 6)}`;
};

export function TransactionsView() {
  const { mode } = useSession();
  const router = useRouter();
  const [limit, setLimit] = useState<(typeof PAGE_SIZES)[number]>(50);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data, error, loading, reload } = useApiData<{ data: TransactionRow[] }>(`/api/v1/transactions?limit=${limit}`, [mode, limit]);
  const rows = data?.data ?? [];

  const statuses = useMemo(() => Array.from(new Set(rows.map((row) => row.payment_status))).sort(), [rows]);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(
      (row) => (!term || row.order_id.toLowerCase().includes(term)) && (!statusFilter || row.payment_status === statusFilter),
    );
  }, [rows, search, statusFilter]);

  /** Whole-row click for mouse users. Links keep their own behaviour, and the order link is the keyboard path. */
  function openRow(event: MouseEvent<HTMLTableRowElement>, paymentId: string) {
    if ((event.target as HTMLElement).closest('a,button')) return;
    router.push(`/payments/${paymentId}`);
  }

  return (
    <>
      <PageHeader
        title="Transactions"
        description={`The ${limit} most recent payments in ${mode === 'live' ? 'live' : 'test'} mode, with how each one settled.`}
        actions={<Button variant="outline" onClick={reload} loading={loading && !!data}>Refresh</Button>}
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <TextField
            label="Search order ID"
            type="search"
            placeholder="ORDER-10482"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            wrapperClassName="w-full sm:w-64"
          />
          <SelectField
            label="Payment status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            wrapperClassName="w-full sm:w-56"
            options={[{ value: '', label: 'All statuses' }, ...statuses.map((status) => ({ value: status, label: humanize(status) }))]}
          />
          <SelectField
            label="Rows"
            value={String(limit)}
            onChange={(event) => setLimit(Number(event.target.value) as (typeof PAGE_SIZES)[number])}
            wrapperClassName="w-full sm:w-28"
            options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
          />
          <p className="pb-2 text-xs text-muted-foreground sm:ml-auto">
            Showing {visible.length} of {rows.length} loaded.
          </p>
        </div>

        {error && (
          <div className="p-4">
            <Notice tone="error" title="Transactions could not be loaded.">
              {error.message}
            </Notice>
          </div>
        )}

        {!data && loading && <LoadingBlock lines={6} label="Loading transactions" />}

        {data && rows.length === 0 && (
          <EmptyState
            title="No transactions yet"
            description="Payments appear here once they are created through the API or checkout. Test mode shows sandbox payments."
          />
        )}

        {data && rows.length > 0 && visible.length === 0 && (
          <EmptyState title="No matching transactions" description="Clear the search or status filter to see every row loaded." />
        )}

        {visible.length > 0 && (
          <TableFrame label="Transactions table. Scroll horizontally to see every column." className="rounded-none">
            <Table>
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th className="text-right">Customer amount</Th>
                  <Th>Method</Th>
                  <Th>Payment status</Th>
                  <Th>Crypto</Th>
                  <Th className="text-right">Crypto amount</Th>
                  <Th>Exchange rate</Th>
                  <Th className="text-right">Network fee</Th>
                  <Th className="text-right">Platform fee</Th>
                  <Th className="text-right">Merchant received</Th>
                  <Th>Wallet</Th>
                  <Th>Blockchain</Th>
                  <Th>Transaction</Th>
                  <Th>Created</Th>
                  <Th>Settlement</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const explorer = explorerTxUrl(row.blockchain, row.transaction_hash);
                  const chain = row.blockchain ? CHAIN_BY_KEY[row.blockchain] : undefined;
                  return (
                    <tr
                      key={row.payment_id}
                      onClick={(event) => openRow(event, row.payment_id)}
                      className="cursor-pointer transition-colors hover:bg-muted/50"
                    >
                      <Td className="font-medium whitespace-nowrap">
                        <Link href={`/payments/${row.payment_id}`} className="text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded">
                          {row.order_id}
                        </Link>
                      </Td>
                      <Td className="text-right font-medium whitespace-nowrap tabular-nums">{formatAmount(row.customer_amount, row.currency)}</Td>
                      <Td className="whitespace-nowrap">{humanize(row.payment_method)}</Td>
                      <Td>
                        <StatusBadge status={row.payment_status} />
                      </Td>
                      <Td className="whitespace-nowrap">{row.crypto_asset}</Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">{formatDecimal(row.crypto_amount)}</Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {row.exchange_rate ? (
                          <span title={row.exchange_rate}>
                            1 {row.crypto_asset} = {shortRate(row.exchange_rate)} {row.currency}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">{formatAmount(row.network_fee, row.currency)}</Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">{formatAmount(row.platform_fee, row.currency)}</Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">
                        {row.merchant_received ? formatAmount(row.merchant_received, row.crypto_asset) : '—'}
                      </Td>
                      <Td>
                        <code className="font-mono text-xs whitespace-nowrap" title={row.wallet_address ?? undefined}>
                          {truncateMiddle(row.wallet_address)}
                        </code>
                      </Td>
                      <Td className="whitespace-nowrap">{chain ? chain.label : humanize(row.blockchain)}</Td>
                      <Td>
                        {explorer ? (
                          <a
                            href={explorer}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs whitespace-nowrap text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded"
                            aria-label={`Transaction ${row.transaction_hash} on ${explorerName(row.blockchain)} (opens in a new tab)`}
                            title={row.transaction_hash ?? undefined}
                          >
                            {truncateMiddle(row.transaction_hash, 10, 6)}
                            <Icon name="external" className="size-3" />
                          </a>
                        ) : (
                          <code className="font-mono text-xs whitespace-nowrap" title={row.transaction_hash ?? undefined}>
                            {truncateMiddle(row.transaction_hash, 10, 6)}
                          </code>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">{formatDateTime(row.timestamp)}</Td>
                      <Td>{row.settlement_status ? <StatusBadge status={row.settlement_status} /> : <Badge>Not created</Badge>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        The API returns the most recent rows without a date filter or cursor. Use the order search, or the payments API for older records.
      </p>
    </>
  );
}
