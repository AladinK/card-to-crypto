'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useSession } from '@/components/session-provider';
import { PageHeader } from '@/components/shell/brand';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Notice } from '@/components/ui/states';
import { ValueBox } from '@/components/ui/copy-button';
import { useToast } from '@/components/ui/toast';
import { apiFetch, messageOf } from '@/lib/client/api';
import { humanize } from '@/lib/format';
import type { MfaSetup } from '@/lib/types';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words sm:text-right">{children}</dd>
    </div>
  );
}

export function SettingsView() {
  const { session, reload } = useSession();
  const { notify } = useToast();
  const { user, merchant, liveEnabled } = session;
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabledNow, setEnabledNow] = useState(false);

  async function startSetup() {
    setError(null);
    setBusy(true);
    try {
      setSetup(await apiFetch<MfaSetup>('/api/v1/auth/mfa/setup', { method: 'POST' }));
      setCode('');
    } catch (err) {
      setError(messageOf(err, 'Two-factor setup could not be started.'));
    } finally {
      setBusy(false);
    }
  }

  async function enable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code shown in your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/api/v1/auth/mfa/enable', { method: 'POST', body: { code } });
      setSetup(null);
      setEnabledNow(true);
      notify({ tone: 'success', title: 'Two-factor authentication is on' });
      await reload();
    } catch (err) {
      setError(messageOf(err, 'The code is not valid. Check your authenticator app and try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Your sign-in security and merchant account status." />

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <Card title="Account" description="The user you are signed in as.">
          <dl className="divide-y divide-border">
            <Row label="Email">{user.email}</Row>
            <Row label="Role">{humanize(user.role)}</Row>
            <Row label="Two-factor authentication">
              {user.mfa_enabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>}
            </Row>
          </dl>
        </Card>

        <Card title="Merchant" description="Business verification and payment modes.">
          {merchant ? (
            <dl className="divide-y divide-border">
              <Row label="Business name">{merchant.name}</Row>
              <Row label="Account status">
                <StatusBadge status={merchant.status} />
              </Row>
              <Row label="Business verification">
                <StatusBadge status={merchant.kyb_status} />
              </Row>
              <Row label="Live payments">
                {liveEnabled ? <Badge tone="live">Enabled</Badge> : <Badge>Not enabled</Badge>}
              </Row>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No merchant is linked to this account.</p>
          )}
        </Card>

        <Card title="Two-factor authentication" description="Adds a 6-digit code from an authenticator app at sign-in. Live actions require it." className="lg:col-span-2">
          {error && (
            <div className="mb-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          {user.mfa_enabled ? (
            <Notice tone="success" title="Two-factor authentication is on.">
              {enabledNow
                ? 'Your current session was started before it was enabled. Sign out and sign in again so live actions are allowed.'
                : 'You will be asked for a code from your authenticator app when you sign in.'}
            </Notice>
          ) : !setup ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Set up an app such as Google Authenticator, 1Password or Authy. You will enter the key shown here, then confirm it with a code.
              </p>
              <Button onClick={startSetup} loading={busy}>
                Set up two-factor authentication
              </Button>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-5">
                <ValueBox label="1. Setup key" value={setup.secret} />
                <ValueBox label="Or open this link in your authenticator app" value={setup.otpauth_uri} />
              </div>
              <form onSubmit={enable} noValidate className="space-y-5 self-start">
                <TextField
                  label="2. Enter the 6-digit code"
                  name="mfa_code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  hint="Confirms that your app generates the right codes."
                  required
                  autoFocus
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={busy}>
                    Turn on two-factor
                  </Button>
                  <Button variant="ghost" onClick={() => setSetup(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
