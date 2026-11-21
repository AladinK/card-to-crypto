'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './icons';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'modal' | 'drawer';
  /** Set when the dialog must not be dismissed by Escape or the backdrop (for example, one-time secrets during copy). */
  dismissible?: boolean;
}

const SIZE: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

/**
 * Accessible modal built on the native <dialog> element: focus is trapped, Escape closes it, and the rest of the
 * page is inert while it is open. The `drawer` variant docks to the left edge (mobile navigation).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  variant = 'modal',
  dismissible = true,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Escape. Prevent the native close so the parent state stays the single source of truth.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/60',
        variant === 'modal' ? SIZE[size] : 'm-0 mr-auto h-dvh max-h-dvh w-72 max-w-[85vw] rounded-none border-y-0 border-l-0',
      )}
    >
      <div className={cn('flex flex-col', variant === 'modal' ? 'max-h-[85dvh]' : 'h-full')}>
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="mt-1 text-sm text-muted-foreground">
                {description}
              </div>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Icon name="close" />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">{footer}</footer>}
      </div>
    </dialog>
  );
}
