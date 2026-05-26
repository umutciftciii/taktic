import Link from 'next/link';
import { apiFetch, ProviderOffer } from '../../../../lib/api';

type ProviderOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderOffersPage({ params }: ProviderOffersPageProps) {
  const { id } = await params;
  const offers = await apiFetch<ProviderOffer[]>(`/providers/${id}/offers`);

  return (
    <main>
      <p>
        <Link href={`/providers/${id}`}>Provider profile</Link>
      </p>
      <h1>Tekliflerim</h1>
      {offers.length === 0 ? <p>Henüz teklif yok.</p> : null}
      {offers.map((offer) => (
        <article key={offer.id}>
          <h2>{offer.request.category.name}</h2>
          <p>
            Konum: {offer.request.city}/{offer.request.district}
          </p>
          <p>
            Fiyat: {offer.priceAmount} {offer.currency}
          </p>
          <p>Kredi maliyeti: {offer.creditCost}</p>
          <p>Kredi iadesi: {offer.creditRefundedAt ? formatDate(offer.creditRefundedAt) : 'Yok'}</p>
          <p>Durum: {offer.status}</p>
          <p>Gönderim: {formatDate(offer.submittedAt)}</p>
          <p>
            <Link href={`/providers/${id}/offers/${offer.id}`}>Detay</Link>
          </p>
        </article>
      ))}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
