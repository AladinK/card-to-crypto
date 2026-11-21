import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Scrolls horizontally inside its own box, never the page. It is focusable so keyboard users can scroll it.
 * `relative` keeps absolutely positioned content (such as sr-only labels) clipped inside the box.
 */
export function TableFrame({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn('relative max-w-full overflow-x-auto rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', className)}
    >
      {children}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cn('w-full border-collapse text-left text-sm', className)}>{children}</table>;
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-border bg-muted/60 px-4 py-2.5 text-xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-border px-4 py-3 align-middle', className)} {...props} />;
}
