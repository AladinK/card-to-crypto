'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField, SelectField } from '@/components/ui/field';
import { Notice } from '@/components/ui/states';
import { ApiError, apiFetch, messageOf } from '@/lib/client/api';

function useAuthSubmit(path: string, onSuccess: () => void) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(body: unknown, onError?: (err: unknown) => boolean) {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(path, { method: 'POST', body });
      onSuccess();
    } catch (err) {
      if (onError?.(err)) return;
      setError(messageOf(err, 'Something went wrong. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, error, setError, submit };
}

/** Email and password, then a 6-digit step when the account has two-factor authentication on. */
export function LoginForm({ expired }: { expired: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);

  const { submitting, error, setError, submit } = useAuthSubmit('/api/auth/login', () => {
    router.replace('/');
    router.refresh();
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsCode && !/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    void submit(needsCode ? { email, password, totp_code: code } : { email, password }, (err) => {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsCode(true);
        setError(null);
        return true;
      }
      if (needsCode && err instanceof ApiError && err.status === 401) {
        setError('That code is not valid. Check your authenticator app and try again.');
        return true;
      }
      return false;
    });
  }

  return (
    <Card title={needsCode ? 'Two-factor check' : 'Sign in'} description={needsCode ? 'Your account uses an authenticator app.' : 'Use the email and password of your merchant account.'} bodyClassName="space-y-5">
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {expired && !error && <Notice tone="info">Your session has ended. Sign in again to continue.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {needsCode ? (
          <>
            <p className="text-sm text-muted-foreground">Signed in as {email}. Enter the current code to continue.</p>
            <TextField
              label="Authentication code"
              name="totp_code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              required
              autoFocus
              hint="The 6-digit code changes every 30 seconds."
            />
          </>
        ) : (
          <>
            <TextField
              label="Email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />
            <TextField
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </>
        )}
        <Button type="submit" block loading={submitting}>
          {needsCode ? 'Verify and sign in' : 'Sign in'}
        </Button>
        {needsCode && (
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => {
              setNeedsCode(false);
              setCode('');
              setError(null);
            }}
          >
            Use a different account
          </button>
        )}
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to CardCrypto?{' '}
        <a href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
          Create a merchant account
        </a>
      </p>
    </Card>
  );
}

const COUNTRY_OPTIONS = [
  { value: '', label: 'Not specified' },
  { value: 'RS', label: 'Serbia (RS)' },
  { value: 'DE', label: 'Germany (DE)' },
  { value: 'FR', label: 'France (FR)' },
  { value: 'GB', label: 'United Kingdom (GB)' },
  { value: 'US', label: 'United States (US)' },
];

export function RegisterForm() {
  const router = useRouter();
  const [merchantName, setMerchantName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const { submitting, error, setError, submit } = useAuthSubmit('/api/auth/register', () => {
    router.replace('/');
    router.refresh();
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password.length < 12) {
      setFieldError('Use at least 12 characters for the password.');
      return;
    }
    setFieldError(null);
    void submit({ merchant_name: merchantName, email, password, country: country || undefined });
  }

  return (
    <Card title="Create your merchant account" description="You will be signed in as the owner. You can enable live payments after business verification." bodyClassName="space-y-5">
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {error && <Notice tone="error">{error}</Notice>}
        <TextField label="Business name" name="merchant_name" autoComplete="organization" value={merchantName} onChange={(e) => setMerchantName(e.target.value)} maxLength={120} required autoFocus />
        <TextField label="Work email" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          maxLength={200}
          required
          hint="At least 12 characters."
          error={fieldError}
        />
        <SelectField label="Country" name="country" value={country} onChange={(e) => setCountry(e.target.value)} options={COUNTRY_OPTIONS} hint="Optional. Used for compliance checks." />
        <Button type="submit" block loading={submitting}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <a href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </a>
      </p>
    </Card>
  );
}
