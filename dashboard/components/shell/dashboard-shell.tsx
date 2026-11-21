'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useSession } from '@/components/session-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Icon, type IconName } from '@/components/ui/icons';
import { StatusBadge, ModeBadge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { ModeSwitch } from './mode-switch';
import { ThemeToggle } from './theme-toggle';
import { Brand } from './brand';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  isActive: (pathname: string) => boolean;
}

const NAV: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: 'overview', isActive: (p) => p === '/' },
  {
    href: '/transactions',
    label: 'Transactions',
    icon: 'transactions',
    isActive: (p) => p.startsWith('/transactions') || p.startsWith('/payments'),
  },
  { href: '/wallets', label: 'Wallets', icon: 'wallet', isActive: (p) => p.startsWith('/wallets') },
  { href: '/developers', label: 'Developers', icon: 'code', isActive: (p) => p.startsWith('/developers') },
  { href: '/settings', label: 'Settings', icon: 'settings', isActive: (p) => p.startsWith('/settings') },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="space-y-1">
        {NAV.map((item) => {
          const active = item.isActive(pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon name={item.icon} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function MerchantFooter() {
  const { session } = useSession();
  const merchant = session.merchant;
  return (
    <div className="space-y-2 border-t border-border px-3 pt-4 text-sm">
      <p className="truncate font-medium" title={merchant?.name}>
        {merchant?.name ?? 'No merchant'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {merchant && <StatusBadge status={merchant.kyb_status} />}
        <span className="text-xs text-muted-foreground">
          {session.liveEnabled ? 'Live payments enabled' : 'Live payments not enabled'}
        </span>
      </div>
    </div>
  );
}

/** Shell for every signed-in page: sidebar on desktop, drawer on phones, top bar with mode and sign-out. */
export function DashboardShell({ children }: { children: ReactNode }) {
  const { session, mode, signOut } = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >
        Skip to main content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-sidebar px-3 py-5 lg:flex">
        <div className="px-3 pb-6">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavList />
        </div>
        <MerchantFooter />
      </aside>

      <Dialog open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Navigation" variant="drawer">
        <div className="flex h-full flex-col gap-6">
          <Brand />
          <div className="flex-1 overflow-y-auto">
            <NavList onNavigate={() => setDrawerOpen(false)} />
          </div>
          <MerchantFooter />
        </div>
      </Dialog>

      <div className="min-w-0 lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur sm:gap-3 sm:px-6 lg:px-8">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 lg:hidden"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="menu" className="size-5" />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ModeBadge mode={mode} />
            <span className="sr-only">Current mode: {mode === 'live' ? 'live' : 'test'}</span>
          </div>
          <ModeSwitch />
          <ThemeToggle />
          <span className="hidden max-w-48 truncate text-sm text-muted-foreground xl:inline" title={session.user.email}>
            {session.user.email}
          </span>
          <Button
            variant="outline"
            size="sm"
            loading={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await signOut().catch(() => undefined);
            }}
            aria-label="Sign out"
          >
            <Icon name="logout" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-7xl px-4 py-6 focus:outline-none sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
