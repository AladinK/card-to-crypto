'use client';

import { useEffect, useState } from 'react';
import { Icon, type IconName } from '@/components/ui/icons';
import { THEME_COOKIE } from '@/lib/constants';

type Theme = 'system' | 'light' | 'dark';

const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON: Record<Theme, IconName> = { system: 'system', light: 'sun', dark: 'moon' };

function readCookieTheme(): Theme {
  const match = document.cookie.match(/(?:^|;\s*)cc_theme=(light|dark)/);
  return match ? (match[1] as Theme) : 'system';
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    delete root.dataset.theme;
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } else {
    root.dataset.theme = theme;
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  }
}

/** Cycles system, light, dark. The choice is a cookie, so the server renders the right theme on the next visit. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    setTheme(readCookieTheme());
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        const next = NEXT[theme];
        applyTheme(next);
        setTheme(next);
      }}
      aria-label={`Theme: ${LABEL[theme]}. Switch theme.`}
      title={`Theme: ${LABEL[theme]}`}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Icon name={ICON[theme]} />
    </button>
  );
}
