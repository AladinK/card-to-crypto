import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { THEME_COOKIE } from '@/lib/constants';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'CardCrypto Merchant', template: '%s | CardCrypto Merchant' },
  description: 'Settlements, wallets and API access for CardCrypto merchants.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

const THEMES = new Set(['light', 'dark']);

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The theme cookie is read here so the first paint already uses the chosen theme (no script needed under CSP).
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  return (
    <html lang="en" data-theme={theme && THEMES.has(theme) ? theme : undefined}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
