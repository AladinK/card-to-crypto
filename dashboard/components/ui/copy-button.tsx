'use client';

import { useState } from 'react';
import { Button } from './button';
import { useToast } from './toast';
import { Icon } from './icons';

/** Copies a value to the clipboard. The toast region announces the result. */
export function CopyButton({ value, label = 'Copy', size = 'sm' }: { value: string; label?: string; size?: 'sm' | 'md' }) {
  const { notify } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      notify({ tone: 'success', title: 'Copied to clipboard' });
    } catch {
      notify({ tone: 'error', title: 'Copy failed', description: 'Select the text and copy it manually.' });
    }
  }

  return (
    <Button variant="outline" size={size} onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} />
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** A secret or other value that must be shown as text, selectable, and copyable. */
export function ValueBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs break-all select-all">
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
