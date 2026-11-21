'use client';

import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/session-provider';
import { PageHeader } from '@/components/shell/brand';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/field';
import { EmptyState, LoadingBlock, Notice } from '@/components/ui/states';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { apiFetch, messageOf } from '@/lib/client/api';
import { useApiData } from '@/lib/client/use-api-data';
import { CHAINS, CHAIN_BY_KEY } from '@/lib/constants';
import { formatDate, humanize, truncateMiddle } from '@/lib/format';
import type { Wallet, WalletCreated } from '@/lib/types';

const SIGNATURE = /^0x[0-9a-fA-F]{100,2000}$/;

/** Verification details kept in memory for this page visit only. The API shows the message once. */
interface PendingVerification {
  walletId: string;
  blockchain: string;
  asset: string;
  message: string;
  expiresAt: string;
}

export function WalletsView() {
  const { mode } = useSession();
  const { notify } = useToast();
  const wallets = useApiData<{ data: Wallet[] }>('/api/v1/wallet', [mode]);
  const [pending, setPending] = useState<Record<string, PendingVerification>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [verifyTarget, setVerifyTarget] = useState<PendingVerification | null>(null);
  const [disableTarget, setDisableTarget] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = wallets.data?.data ?? [];

  async function setDefault(wallet: Wallet) {
    setBusy(wallet.id);
    try {
      await apiFetch(`/api/v1/wallet/${encodeURIComponent(wallet.id)}/default`, { method: 'POST' });
      notify({ tone: 'success', title: 'Default wallet updated', description: `${humanize(wallet.blockchain)} ${wallet.asset} now settles here.` });
      wallets.reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not set the default', description: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  async function disable(wallet: Wallet) {
    setBusy(wallet.id);
    try {
      await apiFetch(`/api/v1/wallet/${encodeURIComponent(wallet.id)}/disable`, { method: 'POST' });
      notify({ tone: 'success', title: 'Wallet disabled' });
      setDisableTarget(null);
      wallets.reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not disable the wallet', description: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Wallets"
        description={`Settlement wallets for ${mode === 'live' ? 'live' : 'test'} mode. Each wallet must prove ownership by signing a message before it can receive funds.`}
        actions={<Button onClick={() => setAddOpen(true)}>Add wallet</Button>}
      />

      <Card padded={false}>
        {wallets.error && (
          <div className="p-4">
            <Notice tone="error" title="Wallets could not be loaded.">
              {wallets.error.message}
            </Notice>
          </div>
        )}
        {!wallets.data && wallets.loading && <LoadingBlock lines={4} label="Loading wallets" />}
        {wallets.data && rows.length === 0 && (
          <EmptyState
            title="No settlement wallets yet"
            description="Add the wallet that should receive your crypto, then sign the verification message with it."
            action={<Button onClick={() => setAddOpen(true)}>Add your first wallet</Button>}
          />
        )}
        {rows.length > 0 && (
          <TableFrame label="Settlement wallets. Scroll horizontally to see every column." className="rounded-none">
            <Table>
              <thead>
                <tr>
                  <Th>Network</Th>
                  <Th>Asset</Th>
                  <Th>Address</Th>
                  <Th>Status</Th>
                  <Th>Default</Th>
                  <Th>Usable for settlement</Th>
                  <Th>Added</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((wallet) => {
                  const remembered = pending[wallet.id];
                  const chain = CHAIN_BY_KEY[wallet.blockchain];
                  return (
                    <tr key={wallet.id}>
                      <Td className="whitespace-nowrap">{chain?.label ?? humanize(wallet.blockchain)}</Td>
                      <Td className="font-medium">{wallet.asset}</Td>
                      <Td>
                        <code className="font-mono text-xs whitespace-nowrap" title={wallet.address}>
                          {truncateMiddle(wallet.address, 10, 8)}
                        </code>
                      </Td>
                      <Td>
                        <StatusBadge status={wallet.status} />
                      </Td>
                      <Td>{wallet.is_default ? <Badge tone="success">Default</Badge> : '—'}</Td>
                      <Td>{wallet.usable_for_settlement ? 'Yes' : 'No'}</Td>
                      <Td className="whitespace-nowrap">{formatDate(wallet.created_at)}</Td>
                      <Td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {wallet.status === 'UNVERIFIED' &&
                            (remembered ? (
                              <Button size="sm" variant="outline" onClick={() => setVerifyTarget(remembered)}>
                                Verify
                              </Button>
                            ) : (
                              <span className="max-w-56 text-xs text-muted-foreground">
                                Awaiting signature. The message was shown once when the wallet was added.
                              </span>
                            ))}
                          {wallet.status === 'VERIFIED' && !wallet.is_default && (
                            <Button size="sm" variant="outline" loading={busy === wallet.id} onClick={() => setDefault(wallet)}>
                              Set default
                            </Button>
                          )}
                          {wallet.status !== 'DISABLED' && (
                            <Button size="sm" variant="ghost" onClick={() => setDisableTarget(wallet)}>
                              Disable
                            </Button>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </Card>

      <AddWalletDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(created) => {
          const record: PendingVerification = {
            walletId: created.id,
            blockchain: created.blockchain,
            asset: created.asset,
            message: created.verification.message,
            expiresAt: created.verification.expires_at,
          };
          setPending((current) => ({ ...current, [created.id]: record }));
          setAddOpen(false);
          setVerifyTarget(record);
          wallets.reload();
        }}
      />

      <VerifyDialog
        target={verifyTarget}
        onClose={() => setVerifyTarget(null)}
        onVerified={(walletId) => {
          setPending((current) => {
            const next = { ...current };
            delete next[walletId];
            return next;
          });
          setVerifyTarget(null);
          notify({ tone: 'success', title: 'Wallet verified', description: 'You can set it as the default once it is usable.' });
          wallets.reload();
        }}
      />

      <Dialog
        open={disableTarget !== null}
        onClose={() => setDisableTarget(null)}
        title="Disable this wallet?"
        description="Payments will no longer settle to it. This cannot be undone from the dashboard."
        footer={
          <>
            <Button variant="outline" onClick={() => setDisableTarget(null)}>
              Keep wallet
            </Button>
            <Button variant="danger" loading={busy === disableTarget?.id} onClick={() => disableTarget && disable(disableTarget)}>
              Disable wallet
            </Button>
          </>
        }
      >
        {disableTarget && (
          <p className="text-sm">
            {chainLabel(disableTarget.blockchain)} · {disableTarget.asset} · <code className="font-mono text-xs break-all">{disableTarget.address}</code>
          </p>
        )}
      </Dialog>
    </>
  );
}

function chainLabel(key: string): string {
  return CHAIN_BY_KEY[key]?.label ?? humanize(key);
}

function AddWalletDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (wallet: WalletCreated) => void }) {
  const [chain, setChain] = useState<string>(CHAINS[0].key);
  const assets = CHAIN_BY_KEY[chain]?.assets ?? [];
  const [asset, setAsset] = useState<string>(CHAINS[0].assets[0]);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (address.trim().length < 10) {
      setError('Enter the wallet address.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await apiFetch<WalletCreated>('/api/v1/wallet', {
        method: 'POST',
        body: { blockchain: chain, asset, address: address.trim() },
      });
      setAddress('');
      onCreated(created);
    } catch (err) {
      setError(messageOf(err, 'The wallet could not be added.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a settlement wallet"
      description="Use an address you control. You will sign a message with it next."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-wallet-form" loading={submitting}>
            Add wallet
          </Button>
        </>
      }
    >
      <form id="add-wallet-form" onSubmit={submit} noValidate className="space-y-5">
        {error && <Notice tone="error">{error}</Notice>}
        <SelectField
          label="Network"
          name="blockchain"
          value={chain}
          onChange={(event) => {
            const next = event.target.value;
            setChain(next);
            setAsset(CHAIN_BY_KEY[next]?.assets[0] ?? '');
          }}
          options={CHAINS.map((c) => ({ value: c.key, label: c.label }))}
        />
        <SelectField label="Asset" name="asset" value={asset} onChange={(event) => setAsset(event.target.value)} options={assets.map((a) => ({ value: a, label: a }))} />
        <TextField
          label="Wallet address"
          name="address"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={128}
          hint="Use the address that exists on the selected network."
          required
        />
      </form>
    </Dialog>
  );
}

function VerifyDialog({
  target,
  onClose,
  onVerified,
}: {
  target: PendingVerification | null;
  onClose: () => void;
  onVerified: (walletId: string) => void;
}) {
  const [signature, setSignature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target) return;
    setError(null);
    const value = signature.trim();
    if (!SIGNATURE.test(value)) {
      setError('The signature must start with 0x and be the hex output of your wallet signing this exact message.');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/api/v1/wallet/${encodeURIComponent(target.walletId)}/verify`, { method: 'POST', body: { signature: value } });
      setSignature('');
      onVerified(target.walletId);
    } catch (err) {
      setError(messageOf(err, 'The signature could not be verified.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title="Verify wallet ownership"
      description={target ? `${chainLabel(target.blockchain)} · ${target.asset}. Expires ${new Date(target.expiresAt).toLocaleTimeString('en-US', { timeStyle: 'short' })}.` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Later
          </Button>
          <Button type="submit" form="verify-wallet-form" loading={submitting}>
            Verify signature
          </Button>
        </>
      }
    >
      {target && (
        <form id="verify-wallet-form" onSubmit={verify} noValidate className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium">1. Sign this exact message with the wallet</p>
            <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap select-all">
              {target.message}
            </pre>
          </div>
          <TextField
            label="2. Paste the signature"
            name="signature"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x…"
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
            error={error}
            hint="The signature is returned by your wallet (for example, personal_sign or 'Sign message')."
            required
          />
        </form>
      )}
    </Dialog>
  );
}
