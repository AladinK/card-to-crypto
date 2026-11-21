'use client';

import { useId, useState } from 'react';
import { useSession } from '@/components/session-provider';
import { cn } from '@/lib/cn';
import type { Mode } from '@/lib/constants';

const OPTIONS: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'test', label: 'Test' },
  { value: 'live', label: 'Live' },
];

/** Segmented control. Live is disabled until the API reports live_enabled for this merchant. */
export function ModeSwitch() {
  const { mode, setMode, session } = useSession();
  const [pending, setPending] = useState<Mode | null>(null);
  const hintId = useId();
  const liveEnabled = session.liveEnabled;

  return (
    <div role="group" aria-label="Payment mode" className="inline-flex shrink-0 rounded-lg border border-border bg-card p-0.5 text-sm">
      {OPTIONS.map((option) => {
        const active = mode === option.value;
        const disabled = option.value === 'live' && !liveEnabled;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            aria-describedby={disabled ? hintId : undefined}
            title={disabled ? 'Live mode is not enabled for this account yet.' : undefined}
            disabled={disabled || pending !== null}
            onClick={async () => {
              if (active) return;
              setPending(option.value);
              try {
                await setMode(option.value);
              } catch {
                // The provider shows the error as a toast.
              } finally {
                setPending(null);
              }
            }}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? option.value === 'live'
                  ? 'bg-live-soft text-live-text'
                  : 'bg-test-soft text-test-text'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
      {!liveEnabled && (
        <span id={hintId} className="sr-only">
          Live mode is not enabled for this account.
        </span>
      )}
    </div>
  );
}
