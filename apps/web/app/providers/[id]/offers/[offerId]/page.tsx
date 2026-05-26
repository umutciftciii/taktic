import Link from 'next/link';
import { apiFetch, ProviderOffer } from '../../../../../lib/api';

type ProviderOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
};

export default async function ProviderOfferDetailPage({ params }: ProviderOfferDetailPageProps) {
  const { id, offerId } = await params;
  const offer = await apiFetch<ProviderOffer>(`/providers/${id}/offers/${offerId}`);

  return (
    <main>
      <p>
        <Link href={`/providers/${id}/offers`}>Tekliflerim</Link>
      </p>
      <h1>Teklif Detayı</h1>
      <p>Talep kategorisi: {offer.request.category.name}</p>
      <p>
        Talep konumu: {offer.request.city}/{offer.request.district}
      </p>
      <p>
        Fiyat: {offer.priceAmount} {offer.currency}
      </p>
      <p>Durum: {offer.status}</p>
      <p>Mesaj: {offer.message}</p>
      <p>Garanti notu: {offer.warrantyNote ?? '-'}</p>
      <p>İç not: {offer.internalNote ?? '-'}</p>
      <p>Gönderim: {formatDate(offer.submittedAt)}</p>
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
