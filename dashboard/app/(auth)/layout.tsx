import type { ReactNode } from 'react';
import { Brand } from '@/components/shell/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md min-w-0">
        <Brand className="mb-8 justify-center" />
        {children}
      </div>
    </div>
  );
}
