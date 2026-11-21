import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { Mode } from '@/lib/constants';
import { humanize, statusTone, type Tone } from '@/lib/format';

const TONES: Record<Tone, string> = {
  neutral: 'bg-muted text-foreground ring-border',
  success: 'bg-success-soft text-success-text ring-success-text/25',
  warning: 'bg-warning-soft text-warning-text ring-warning-text/25',
  danger: 'bg-danger-soft text-danger-text ring-danger/30',
  info: 'bg-info-soft text-info-text ring-info-text/25',
  test: 'bg-test-soft text-test-text ring-test-border',
  live: 'bg-live-soft text-live-text ring-live-border',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Status text is always shown, so color is never the only signal. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge tone={statusTone(status)}>{humanize(status)}</Badge>;
}

export function ModeBadge({ mode }: { mode: Mode }) {
  return mode === 'live' ? (
    <Badge tone="live" className="font-semibold tracking-wide">
      LIVE
    </Badge>
  ) : (
    <Badge tone="test" className="font-semibold tracking-wide">
      TEST
    </Badge>
  );
}
