'use client';

import { useId, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const CONTROL =
  'w-full min-w-0 rounded-lg border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

interface FieldFrame {
  label: string;
  hint?: string;
  error?: string | null;
  describedBy?: string;
}

function useFieldIds(id?: string) {
  const generated = useId();
  const base = id ?? generated;
  return { inputId: base, hintId: `${base}-hint`, errorId: `${base}-error` };
}

function describedBy(ids: ReturnType<typeof useFieldIds>, hint?: string, error?: string | null): string | undefined {
  const parts = [hint ? ids.hintId : null, error ? ids.errorId : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function FieldMessages({ ids, hint, error }: { ids: ReturnType<typeof useFieldIds>; hint?: string; error?: string | null }) {
  return (
    <>
      {hint && (
        <p id={ids.hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={ids.errorId} className="text-xs font-medium text-danger-text">
          {error}
        </p>
      )}
    </>
  );
}

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & FieldFrame & { wrapperClassName?: string };

export function TextField({ id, label, hint, error, wrapperClassName, className, ...input }: TextFieldProps) {
  const ids = useFieldIds(id);
  return (
    <div className={cn('min-w-0 space-y-1.5', wrapperClassName)}>
      <label htmlFor={ids.inputId} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={ids.inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        className={cn(CONTROL, 'h-10', error ? 'border-danger' : 'border-input', className)}
        {...input}
      />
      <FieldMessages ids={ids} hint={hint} error={error} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> &
  FieldFrame & { options: readonly SelectOption[]; wrapperClassName?: string };

export function SelectField({ id, label, hint, error, options, wrapperClassName, className, ...select }: SelectFieldProps) {
  const ids = useFieldIds(id);
  return (
    <div className={cn('min-w-0 space-y-1.5', wrapperClassName)}>
      <label htmlFor={ids.inputId} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={ids.inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        className={cn(CONTROL, 'h-10 pr-8', error ? 'border-danger' : 'border-input', className)}
        {...select}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessages ids={ids} hint={hint} error={error} />
    </div>
  );
}

export function CheckField({
  id,
  label,
  hint,
  className,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const ids = useFieldIds(id);
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input
        id={ids.inputId}
        type="checkbox"
        aria-describedby={hint ? ids.hintId : undefined}
        className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        {...input}
      />
      <div className="min-w-0">
        <label htmlFor={ids.inputId} className="block text-sm">
          {label}
        </label>
        {hint && (
          <p id={ids.hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
