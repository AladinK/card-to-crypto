import type { Metadata } from 'next';
import { DevelopersView } from '@/components/views/developers-view';

export const metadata: Metadata = { title: 'Developers' };

export default function DevelopersPage() {
  return <DevelopersView />;
}
