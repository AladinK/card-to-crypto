import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/components/session-provider';
import { DashboardShell } from '@/components/shell/dashboard-shell';
import { REFRESH_COOKIE } from '@/lib/bff/cookies';

/**
 * Gate for signed-in pages. Only the presence of the refresh cookie is checked here. The API confirms the session
 * on the first client request (/api/session), and an expired session sends the user to /login from there.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!jar.get(REFRESH_COOKIE)) redirect('/login');
  return (
    <SessionProvider>
      <DashboardShell>{children}</DashboardShell>
    </SessionProvider>
  );
}
