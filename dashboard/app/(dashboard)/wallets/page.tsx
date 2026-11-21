import type { Metadata } from 'next';
import { WalletsView } from '@/components/views/wallets-view';

export const metadata: Metadata = { title: 'Wallets' };

export default function WalletsPage() {
  return <WalletsView />;
}
