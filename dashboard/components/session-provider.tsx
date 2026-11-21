'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, apiFetch, messageOf } from '@/lib/client/api';
import { SESSION_EXPIRED_EVENT, type Mode } from '@/lib/constants';
import type { SessionInfo } from '@/lib/types';
import { useToast } from './ui/toast';

interface SessionContextValue {
  session: SessionInfo;
  mode: Mode;
  setMode: (mode: Mode) => Promise<void>;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

type Load = { status: 'loading' } | { status: 'ready'; session: SessionInfo } | { status: 'failed'; message: string };

/** Loads the signed-in merchant and the active mode, and owns mode switching and sign-out. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { notify } = useToast();
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  const fetchSession = useCallback(async (): Promise<void> => {
    try {
      const session = await apiFetch<SessionInfo>('/api/session');
      setLoad({ status: 'ready', session });
    } catch (error) {
      // An expired session is handled by the SESSION_EXPIRED_EVENT listener (sends the user to sign in).
      if (error instanceof ApiError && (error.code === 'session_expired' || error.code === 'unauthenticated')) return;
      setLoad({ status: 'failed', message: messageOf(error, 'Could not load your account.') });
    }
  }, []);

  useEffect(() => {
    void fetchSession();
    const onExpired = () => router.replace('/login?expired=1');
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [fetchSession, router]);

  const setMode = useCallback(async (mode: Mode) => {
    try {
      const result = await apiFetch<{ mode: Mode }>('/api/session/mode', { method: 'POST', body: { mode } });
      setLoad((previous) =>
        previous.status === 'ready' ? { status: 'ready', session: { ...previous.session, mode: result.mode } } : previous,
      );
      notify({ tone: 'info', title: result.mode === 'live' ? 'Live mode' : 'Test mode', description: result.mode === 'live' ? 'Showing live payments and settlements.' : 'Showing sandbox data only.' });
    } catch (error) {
      notify({ tone: 'error', title: 'Mode not changed', description: messageOf(error) });
      throw error;
    }
  }, [notify]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }, [router]);

  const value = useMemo<SessionContextValue | null>(() => {
    if (load.status !== 'ready') return null;
    return {
      session: load.session,
      mode: load.session.mode,
      setMode,
      reload: fetchSession,
      signOut,
    };
  }, [load, setMode, fetchSession, signOut]);

  if (load.status === 'failed') {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <div role="alert" className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
          <p className="font-medium">We could not load your account.</p>
          <p className="mt-2 text-sm text-muted-foreground">{load.message}</p>
          <button
            type="button"
            onClick={() => {
              setLoad({ status: 'loading' });
              void fetchSession();
            }}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!value) {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status" aria-live="polite">
        <span className="text-sm text-muted-foreground">Loading your account…</span>
      </div>
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
