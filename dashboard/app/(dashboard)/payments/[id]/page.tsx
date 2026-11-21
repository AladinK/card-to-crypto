import type { Metadata } from 'next';
import { PaymentView } from '@/components/views/payment-view';

export const metadata: Metadata = { title: 'Payment' };

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PaymentView id={id} />;
}
