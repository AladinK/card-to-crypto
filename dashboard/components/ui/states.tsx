import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './icons';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  );
}

export function LoadingBlock({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 p-5">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className={cn('h-4 animate-pulse rounded bg-muted', index === lines - 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon name="overview" />
      </span>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

type NoticeTone = 'error' | 'success' | 'info' | 'warning';

const NOTICE_TONE: Record<NoticeTone, string> = {
  error: 'border-danger/40 bg-danger-soft text-danger-text',
  success: 'border-success-text/30 bg-success-soft text-success-text',
  info: 'border-info-text/30 bg-info-soft text-info-text',
  warning: 'border-warning-text/30 bg-warning-soft text-warning-text',
};

/** Inline message. Errors use role="alert" so screen readers announce them where they occur. */
export function Notice({ tone = 'info', title, children }: { tone?: NoticeTone; title?: string; children?: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border p-3 text-sm', NOTICE_TONE[tone])}
    >
      {tone === 'error' && <Icon name="alert" className="mt-0.5" />}
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="break-words">{children}</div>}
      </div>
    </div>
  );
}
