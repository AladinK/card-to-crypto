import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface CardProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Set to false for full-bleed content such as tables. */
  padded?: boolean;
  id?: string;
}

/** Surface with an optional header. Sections are labelled by their title for screen readers. */
export function Card({ title, description, actions, children, className, bodyClassName, padded = true, id }: CardProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cn('min-w-0 rounded-xl border border-border bg-card text-card-foreground shadow-sm', className)}
    >
      {title && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-semibold">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children && <div className={cn(padded && 'p-5', bodyClassName)}>{children}</div>}
    </section>
  );
}
