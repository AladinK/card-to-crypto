import type { Metadata } from 'next';
import { LoginForm } from '@/components/views/auth-forms';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const params = await searchParams;
  return <LoginForm expired={params.expired === '1'} />;
}
