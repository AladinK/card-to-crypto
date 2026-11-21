'use client';

import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/session-provider';
import { PageHeader } from '@/components/shell/brand';
import { Badge, ModeBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CheckField, SelectField, TextField } from '@/components/ui/field';
import { EmptyState, LoadingBlock, Notice } from '@/components/ui/states';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { ValueBox } from '@/components/ui/copy-button';
import { apiFetch, messageOf } from '@/lib/client/api';
import { useApiData } from '@/lib/client/use-api-data';
import { DELIVERY_STATUSES, WEBHOOK_EVENTS } from '@/lib/constants';
import { formatDateTime, humanize, truncateMiddle } from '@/lib/format';
import type { ApiKey, ApiKeySecret, DeliveryDetail, DeliverySummary, WebhookEndpoint, WebhookSecret } from '@/lib/types';

/** A one-time secret. It lives in component state only until the dialog is closed. */
interface SecretShown {
  title: string;
  label: string;
  value: string;
  note: string;
}

const enc = encodeURIComponent;

export function DevelopersView() {
  const { mode, session } = useSession();
  const { notify } = useToast();
  const keys = useApiData<{ data: ApiKey[] }>('/api/v1/api-keys', [mode]);
  const endpoints = useApiData<{ data: WebhookEndpoint[] }>('/api/v1/webhook-endpoints', [mode]);
  const [statusFilter, setStatusFilter] = useState('');
  const deliveries = useApiData<{ data: DeliverySummary[] }>(
    `/api/v1/webhook-deliveries${statusFilter ? `?status=${enc(statusFilter)}` : ''}`,
    [mode, statusFilter],
  );

  const [secret, setSecret] = useState<SecretShown | null>(null);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [rotateKey, setRotateKey] = useState<ApiKey | null>(null);
  const [revokeKey, setRevokeKey] = useState<ApiKey | null>(null);
  const [createEndpointOpen, setCreateEndpointOpen] = useState(false);
  const [rotateEndpoint, setRotateEndpoint] = useState<WebhookEndpoint | null>(null);
  const [disableEndpoint, setDisableEndpoint] = useState<WebhookEndpoint | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const liveEnabled = session.liveEnabled;

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      notify({ tone: 'error', title: failure, description: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Developers" description={`API keys, webhooks and deliveries for ${mode === 'live' ? 'live' : 'test'} mode.`} />

      <div className="space-y-6">
        {/* API keys */}
        <Card
          id="api-keys"
          title="API keys"
          description="Secret keys for your server. The full key is shown once, when it is created or rotated."
          actions={<Button onClick={() => setCreateKeyOpen(true)}>Create API key</Button>}
          padded={false}
        >
          {keys.error && <div className="p-4"><Notice tone="error">{keys.error.message}</Notice></div>}
          {!keys.data && keys.loading && <LoadingBlock lines={3} label="Loading API keys" />}
          {keys.data && keys.data.data.length === 0 && (
            <EmptyState title="No API keys yet" description="Create a key, then store it in your server's secret manager." />
          )}
          {keys.data && keys.data.data.length > 0 && (
            <TableFrame label="API keys. Scroll horizontally to see every column." className="rounded-none">
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Mode</Th>
                    <Th>Key prefix</Th>
                    <Th>Created</Th>
                    <Th>Last used</Th>
                    <Th>Status</Th>
                    <Th><span className="sr-only">Actions</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {keys.data.data.map((key) => (
                    <tr key={key.id}>
                      <Td className="font-medium whitespace-nowrap">{key.name}</Td>
                      <Td><ModeBadge mode={key.mode} /></Td>
                      <Td><code className="font-mono text-xs whitespace-nowrap">{key.key_prefix}…</code></Td>
                      <Td className="whitespace-nowrap">{formatDateTime(key.created_at)}</Td>
                      <Td className="whitespace-nowrap">{formatDateTime(key.last_used_at)}</Td>
                      <Td>{key.revoked_at ? <Badge tone="danger">Revoked</Badge> : <Badge tone="success">Active</Badge>}</Td>
                      <Td>
                        {!key.revoked_at && (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => setRotateKey(key)}>Rotate</Button>
                            <Button size="sm" variant="ghost" onClick={() => setRevokeKey(key)}>Revoke</Button>
                          </div>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          )}
        </Card>

        {/* Webhook endpoints */}
        <Card
          id="webhooks"
          title="Webhook endpoints"
          description="HTTPS URLs that receive signed event notifications. The signing secret is shown once."
          actions={<Button onClick={() => setCreateEndpointOpen(true)}>Add endpoint</Button>}
          padded={false}
        >
          {endpoints.error && <div className="p-4"><Notice tone="error">{endpoints.error.message}</Notice></div>}
          {!endpoints.data && endpoints.loading && <LoadingBlock lines={3} label="Loading endpoints" />}
          {endpoints.data && endpoints.data.data.length === 0 && (
            <EmptyState title="No webhook endpoints" description="Add an endpoint to receive payment and settlement events." />
          )}
          {endpoints.data && endpoints.data.data.length > 0 && (
            <TableFrame label="Webhook endpoints. Scroll horizontally to see every column." className="rounded-none">
              <Table>
                <thead>
                  <tr>
                    <Th>URL</Th>
                    <Th>Events</Th>
                    <Th>Status</Th>
                    <Th>Created</Th>
                    <Th><span className="sr-only">Actions</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.data.data.map((endpoint) => (
                    <tr key={endpoint.id}>
                      <Td className="max-w-xs">
                        <span className="block truncate font-mono text-xs" title={endpoint.url}>{endpoint.url}</span>
                      </Td>
                      <Td className="text-xs">{endpoint.events.includes('*') ? 'All events' : `${endpoint.events.length} event type${endpoint.events.length === 1 ? '' : 's'}`}</Td>
                      <Td><StatusBadge status={endpoint.status} /></Td>
                      <Td className="whitespace-nowrap">{formatDateTime(endpoint.created_at)}</Td>
                      <Td>
                        {endpoint.status === 'ACTIVE' && (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => setRotateEndpoint(endpoint)}>Rotate secret</Button>
                            <Button size="sm" variant="ghost" onClick={() => setDisableEndpoint(endpoint)}>Disable</Button>
                          </div>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          )}
        </Card>

        {/* Deliveries */}
        <Card
          id="deliveries"
          title="Webhook deliveries"
          description="Every attempt to send an event. Replay a delivery to send it again."
          actions={
            <SelectField
              label="Status"
              wrapperClassName="w-44"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              options={[{ value: '', label: 'All statuses' }, ...DELIVERY_STATUSES.map((s) => ({ value: s, label: humanize(s) }))]}
            />
          }
          padded={false}
        >
          {deliveries.error && <div className="p-4"><Notice tone="error">{deliveries.error.message}</Notice></div>}
          {!deliveries.data && deliveries.loading && <LoadingBlock lines={3} label="Loading deliveries" />}
          {deliveries.data && deliveries.data.data.length === 0 && (
            <EmptyState title="No deliveries" description="Deliveries appear once an event is sent to an endpoint." />
          )}
          {deliveries.data && deliveries.data.data.length > 0 && (
            <TableFrame label="Webhook deliveries. Scroll horizontally to see every column." className="rounded-none">
              <Table>
                <thead>
                  <tr>
                    <Th>Event</Th>
                    <Th>Endpoint</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Attempts</Th>
                    <Th>Last response</Th>
                    <Th>Created</Th>
                    <Th><span className="sr-only">Actions</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.data.data.map((delivery) => (
                    <tr key={delivery.id}>
                      <Td className="font-mono text-xs whitespace-nowrap">{delivery.event}</Td>
                      <Td className="max-w-[14rem]"><span className="block truncate text-xs" title={delivery.endpoint_url}>{truncateMiddle(delivery.endpoint_url, 26, 10)}</span></Td>
                      <Td><StatusBadge status={delivery.status} /></Td>
                      <Td className="text-right tabular-nums">{delivery.attempts}</Td>
                      <Td className="text-xs whitespace-nowrap">
                        {delivery.last_status_code ? `HTTP ${delivery.last_status_code}` : delivery.last_error ? truncateMiddle(delivery.last_error, 24, 0) : '—'}
                      </Td>
                      <Td className="whitespace-nowrap">{formatDateTime(delivery.created_at)}</Td>
                      <Td>
                        <div className="flex justify-end">
                          <Button size="sm" variant="outline" onClick={() => setDeliveryId(delivery.id)}>View</Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          )}
        </Card>
      </div>

      {/* API key dialogs */}
      <CreateKeyDialog
        open={createKeyOpen}
        liveEnabled={liveEnabled}
        onClose={() => setCreateKeyOpen(false)}
        onCreated={(created) => {
          setCreateKeyOpen(false);
          setSecret({ title: 'API key created', label: 'Secret key', value: created.secret, note: 'Store it now in your server secret manager. You cannot view it again.' });
          keys.reload();
        }}
      />
      <Dialog
        open={rotateKey !== null}
        onClose={() => setRotateKey(null)}
        title="Rotate API key"
        description="Creates a replacement key. The old key keeps working for the grace period, then stops."
        footer={
          <>
            <Button variant="outline" onClick={() => setRotateKey(null)}>Cancel</Button>
            <Button
              loading={busy}
              form="rotate-key-form"
              type="submit"
            >
              Rotate key
            </Button>
          </>
        }
      >
        {rotateKey && <RotateKeyForm id="rotate-key-form" keyName={rotateKey.name} onSubmit={(graceHours) => run(async () => {
          const rotated = await apiFetch<ApiKeySecret>(`/api/v1/api-keys/${enc(rotateKey.id)}/rotate`, { method: 'POST', body: { grace_hours: graceHours } });
          setRotateKey(null);
          setSecret({ title: 'API key rotated', label: 'New secret key', value: rotated.secret, note: `The old key expires after ${graceHours} hours. Store the new key now; it cannot be shown again.` });
          keys.reload();
        }, 'Could not rotate the key')} />}
      </Dialog>
      <Dialog
        open={revokeKey !== null}
        onClose={() => setRevokeKey(null)}
        title="Revoke API key?"
        description="Requests that use this key will fail immediately. This cannot be undone."
        footer={
          <>
            <Button variant="outline" onClick={() => setRevokeKey(null)}>Keep key</Button>
            <Button variant="danger" loading={busy} onClick={() => revokeKey && run(async () => {
              await apiFetch(`/api/v1/api-keys/${enc(revokeKey.id)}/revoke`, { method: 'POST' });
              setRevokeKey(null);
              notify({ tone: 'success', title: 'API key revoked' });
              keys.reload();
            }, 'Could not revoke the key')}>Revoke key</Button>
          </>
        }
      >
        {revokeKey && <p className="text-sm">{revokeKey.name} ({revokeKey.key_prefix}…)</p>}
      </Dialog>

      {/* Webhook dialogs */}
      <CreateEndpointDialog
        open={createEndpointOpen}
        onClose={() => setCreateEndpointOpen(false)}
        onCreated={(created) => {
          setCreateEndpointOpen(false);
          setSecret({ title: 'Webhook endpoint added', label: 'Signing secret', value: created.secret, note: 'Use this secret to verify the CardCrypto-Signature header. It is shown once.' });
          endpoints.reload();
        }}
      />
      <Dialog
        open={rotateEndpoint !== null}
        onClose={() => setRotateEndpoint(null)}
        title="Rotate signing secret?"
        description="Deliveries are signed with the new secret from now on. Update your server before rotating."
        footer={
          <>
            <Button variant="outline" onClick={() => setRotateEndpoint(null)}>Cancel</Button>
            <Button loading={busy} onClick={() => rotateEndpoint && run(async () => {
              const rotated = await apiFetch<WebhookSecret>(`/api/v1/webhook-endpoints/${enc(rotateEndpoint.id)}/rotate-secret`, { method: 'POST' });
              setRotateEndpoint(null);
              setSecret({ title: 'Signing secret rotated', label: 'New signing secret', value: rotated.secret, note: 'The previous secret stops working once you deploy the new one. It is shown once.' });
              endpoints.reload();
            }, 'Could not rotate the secret')}>Rotate secret</Button>
          </>
        }
      >
        {rotateEndpoint && <p className="font-mono text-xs break-all">{rotateEndpoint.url}</p>}
      </Dialog>
      <Dialog
        open={disableEndpoint !== null}
        onClose={() => setDisableEndpoint(null)}
        title="Disable this endpoint?"
        description="No further events will be sent to this URL."
        footer={
          <>
            <Button variant="outline" onClick={() => setDisableEndpoint(null)}>Keep endpoint</Button>
            <Button variant="danger" loading={busy} onClick={() => disableEndpoint && run(async () => {
              await apiFetch(`/api/v1/webhook-endpoints/${enc(disableEndpoint.id)}/disable`, { method: 'POST' });
              setDisableEndpoint(null);
              notify({ tone: 'success', title: 'Endpoint disabled' });
              endpoints.reload();
            }, 'Could not disable the endpoint')}>Disable endpoint</Button>
          </>
        }
      >
        {disableEndpoint && <p className="font-mono text-xs break-all">{disableEndpoint.url}</p>}
      </Dialog>

      <DeliveryDialog
        deliveryId={deliveryId}
        mode={mode}
        onClose={() => setDeliveryId(null)}
        onReplayed={() => {
          setDeliveryId(null);
          notify({ tone: 'success', title: 'Replay queued', description: 'The event is sent again shortly.' });
          deliveries.reload();
        }}
      />

      {/* One-time secret */}
      <Dialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        title={secret?.title ?? ''}
        description="Shown once. Copy it now."
        footer={<Button onClick={() => setSecret(null)}>I have stored it</Button>}
      >
        {secret && (
          <div className="space-y-4">
            <Notice tone="warning">{secret.note}</Notice>
            <ValueBox label={secret.label} value={secret.value} />
          </div>
        )}
      </Dialog>
    </>
  );
}

function RotateKeyForm({ id, keyName, onSubmit }: { id: string; keyName: string; onSubmit: (graceHours: number) => void }) {
  const [hours, setHours] = useState('24');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      id={id}
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const value = Number(hours);
        if (!Number.isInteger(value) || value < 0 || value > 168) {
          setError('Enter a whole number of hours from 0 to 168.');
          return;
        }
        setError(null);
        onSubmit(value);
      }}
      noValidate
    >
      <p className="text-sm">Rotating <span className="font-medium">{keyName}</span>.</p>
      {error && <Notice tone="error">{error}</Notice>}
      <TextField label="Grace period (hours)" name="grace_hours" type="number" min={0} max={168} value={hours} onChange={(e) => setHours(e.target.value)} hint="0 revokes the old key immediately. The maximum is 168 hours (7 days)." />
    </form>
  );
}

function CreateKeyDialog({
  open,
  liveEnabled,
  onClose,
  onCreated,
}: {
  open: boolean;
  liveEnabled: boolean;
  onClose: () => void;
  onCreated: (created: ApiKeySecret) => void;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'test' | 'live'>('test');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Give the key a name so you can recognise it later.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await apiFetch<ApiKeySecret>('/api/v1/api-keys', { method: 'POST', body: { name: name.trim(), mode } });
      setName('');
      onCreated(created);
    } catch (err) {
      setError(messageOf(err, 'The key could not be created.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create API key"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="create-key-form" loading={submitting}>Create key</Button>
        </>
      }
    >
      <form id="create-key-form" onSubmit={submit} noValidate className="space-y-5">
        {error && <Notice tone="error">{error}</Notice>}
        <TextField label="Name" name="key_name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Checkout server (production)" required autoFocus />
        <SelectField
          label="Mode"
          name="key_mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as 'test' | 'live')}
          options={[
            { value: 'test', label: 'Test (sandbox)' },
            { value: 'live', label: 'Live', disabled: !liveEnabled },
          ]}
          hint={liveEnabled ? 'Live keys need an approved business and two-factor sign-in.' : 'Live keys are unavailable until live payments are enabled for this account.'}
        />
      </form>
    </Dialog>
  );
}

function CreateEndpointDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (created: WebhookSecret) => void }) {
  const [url, setUrl] = useState('');
  const [allEvents, setAllEvents] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const selected = allEvents ? ['*'] : events;
    if (!url.trim()) return setError('Enter the HTTPS URL that receives events.');
    if (selected.length === 0) return setError('Choose at least one event type.');
    setSubmitting(true);
    try {
      const created = await apiFetch<WebhookSecret & { url: string }>('/api/v1/webhook-endpoints', {
        method: 'POST',
        body: { url: url.trim(), events: selected },
      });
      setUrl('');
      onCreated(created);
    } catch (err) {
      setError(messageOf(err, 'The endpoint could not be added.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add webhook endpoint"
      description="Events are sent as signed POST requests."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="create-endpoint-form" loading={submitting}>Add endpoint</Button>
        </>
      }
    >
      <form id="create-endpoint-form" onSubmit={submit} noValidate className="space-y-5">
        {error && <Notice tone="error">{error}</Notice>}
        <TextField label="Endpoint URL" name="url" type="url" inputMode="url" placeholder="https://example.com/webhooks/cardcrypto" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} required autoFocus />
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">Events</legend>
          <CheckField label="All events" hint="Receive every event type, including ones added later." checked={allEvents} onChange={(e) => setAllEvents(e.target.checked)} />
          <div className="grid gap-x-6 gap-y-2 border-l-2 border-border pl-4 sm:grid-cols-2">
            {WEBHOOK_EVENTS.map((type) => (
              <CheckField
                key={type}
                label={type}
                disabled={allEvents}
                checked={events.includes(type)}
                onChange={(e) => setEvents((current) => (e.target.checked ? [...current, type] : current.filter((t) => t !== type)))}
              />
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function DeliveryDialog({
  deliveryId,
  mode,
  onClose,
  onReplayed,
}: {
  deliveryId: string | null;
  mode: string;
  onClose: () => void;
  onReplayed: () => void;
}) {
  const detail = useApiData<DeliveryDetail>(deliveryId ? `/api/v1/webhook-deliveries/${enc(deliveryId)}` : null, [mode, deliveryId]);
  const { notify } = useToast();
  const [replaying, setReplaying] = useState(false);
  const d = detail.data;

  async function replay() {
    if (!deliveryId) return;
    setReplaying(true);
    try {
      await apiFetch(`/api/v1/webhook-deliveries/${enc(deliveryId)}/replay`, { method: 'POST' });
      onReplayed();
    } catch (error) {
      notify({ tone: 'error', title: 'Replay failed', description: messageOf(error, 'The delivery could not be replayed.') });
    } finally {
      setReplaying(false);
    }
  }

  return (
    <Dialog
      open={deliveryId !== null}
      onClose={onClose}
      title="Webhook delivery"
      description={d ? `${d.event} · ${humanize(d.status)} · ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}` : 'Loading delivery'}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={replay} loading={replaying} disabled={!d}>Replay delivery</Button>
        </>
      }
    >
      {detail.error && <Notice tone="error">{detail.error.message}</Notice>}
      {!d && !detail.error && <LoadingBlock lines={4} label="Loading delivery" />}
      {d && (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Payload</h3>
            <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(d.payload, null, 2)}
            </pre>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Attempt log</h3>
            {d.attempt_log.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attempts yet.</p>
            ) : (
              <TableFrame label="Attempt log">
                <Table>
                  <thead>
                    <tr>
                      <Th>#</Th>
                      <Th>Response</Th>
                      <Th className="text-right">Duration</Th>
                      <Th>Error</Th>
                      <Th>When</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.attempt_log.map((attempt) => (
                      <tr key={attempt.attempt_no}>
                        <Td className="tabular-nums">{attempt.attempt_no}</Td>
                        <Td className="whitespace-nowrap">{attempt.status_code ? `HTTP ${attempt.status_code}` : '—'}</Td>
                        <Td className="text-right tabular-nums">{attempt.duration_ms !== null ? `${attempt.duration_ms} ms` : '—'}</Td>
                        <Td className="text-xs">{attempt.error ?? '—'}</Td>
                        <Td className="whitespace-nowrap">{formatDateTime(attempt.created_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableFrame>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
