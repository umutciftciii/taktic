import Link from 'next/link';
import { apiFetch, RequestOfferPreview, statusLabel } from '../../../../lib/api';

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
      {offers.length === 0 ? <div className="empty-state">Bu talep için henüz teklif yok.</div> : null}
      {offers.map((offer) => (
        <article className="card" key={offer.id}>
          <h2>{offer.provider.businessName}</h2>
          <p>
            <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
            <span className="badge">
              {offer.priceAmount} {offer.currency}
            </span>
          </p>
          <p>
            Provider konumu: {offer.provider.city}/{offer.provider.district}
          </p>
          <p>Başlangıç: {offer.estimatedStartDate ? formatDate(offer.estimatedStartDate) : '-'}</p>
          <p>Bitiş: {offer.estimatedCompletionDate ? formatDate(offer.estimatedCompletionDate) : '-'}</p>
          <p>Mesaj: {offer.message}</p>
          <p>Garanti notu: {offer.warrantyNote ?? '-'}</p>
          <p>Gönderim: {formatDate(offer.submittedAt)}</p>
          <p>
            <Link className="button" href={`/requests/${id}/offers/${offer.id}`}>Teklifi İncele</Link>
          </p>
        </article>
      ))}
    </main>
  );
}

function statusBadgeClass(status: string) {
  if (status === 'ACCEPTED' || status === 'SHORTLISTED') return 'badge badge-good';
  if (status === 'REJECTED') return 'badge badge-bad';
  return 'badge badge-warn';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
