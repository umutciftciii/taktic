import Link from 'next/link';
import { apiFetch, RequestOfferPreview } from '../../../../lib/api';

type RequestOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RequestOffersPage({ params }: RequestOffersPageProps) {
  const { id } = await params;
  const offers = await apiFetch<RequestOfferPreview[]>(`/service-requests/${id}/offers`);

  return (
    <main>
      <p>
        <Link href="/categories">Kategoriler</Link>
      </p>
      <h1>Talep Teklifleri</h1>
      <p>Bu fazda ödeme ve iletişim akışı aktif değildir.</p>
      {offers.length === 0 ? <p>Bu talep için henüz teklif yok.</p> : null}
      {offers.map((offer) => (
        <article key={offer.id}>
          <h2>{offer.provider.businessName}</h2>
          <p>
            Provider konumu: {offer.provider.city}/{offer.provider.district}
          </p>
          <p>
            Fiyat: {offer.priceAmount} {offer.currency}
          </p>
          <p>Durum: {offer.status}</p>
          <p>Mesaj: {offer.message}</p>
          <p>Garanti notu: {offer.warrantyNote ?? '-'}</p>
          <p>Gönderim: {formatDate(offer.submittedAt)}</p>
          <p>
            <Link href={`/requests/${id}/offers/${offer.id}`}>Teklifi İncele</Link>
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
