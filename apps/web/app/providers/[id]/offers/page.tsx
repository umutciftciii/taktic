import Link from 'next/link';
import { apiFetch, ProviderOffer, statusLabel } from '../../../../lib/api';

type ProviderOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderOffersPage({ params }: ProviderOffersPageProps) {
  const { id } = await params;
  const offers = await apiFetch<ProviderOffer[]>(`/providers/${id}/offers`);

  return (
    <main>
      <p>
        <Link href="/providers/me">Panelim</Link> <Link href={`/providers/${id}`}>Profil</Link>
      </p>
      <h1>Tekliflerim</h1>
      {offers.length === 0 ? <div className="empty-state">Henüz teklif vermediniz.</div> : null}
      {offers.map((offer) => (
        <article className="card" key={offer.id}>
          <h2>{offer.request.category.name}</h2>
          <p>
            <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
            <span className="badge">Kredi: {offer.creditCost}</span>
            <span className="badge">İade önerisi: {offer.refundEligibility.recommendedAction}</span>
          </p>
          <p>
            Konum: {offer.request.city}/{offer.request.district}
          </p>
          <p>
            Fiyat: {offer.priceAmount} {offer.currency}
          </p>
          <p>Kredi iadesi: {offer.creditRefundedAt ? formatDate(offer.creditRefundedAt) : 'Yok'}</p>
          <p>Gönderim: {formatDate(offer.submittedAt)}</p>
          <p>
            <Link href={`/providers/${id}/offers/${offer.id}`}>Detay</Link>{' '}
            <Link href={`/providers/${id}/requests/${offer.request.id}`}>Talep detayı</Link>
          </p>
        </article>
      ))}
    </main>
  );
}

function statusBadgeClass(status: string) {
  if (status === 'ACCEPTED' || status === 'SHORTLISTED') {
    return 'badge badge-good';
  }

  if (status === 'REJECTED' || status === 'WITHDRAWN' || status === 'CANCELLED' || status === 'EXPIRED') {
    return 'badge badge-bad';
  }

  return 'badge badge-warn';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
