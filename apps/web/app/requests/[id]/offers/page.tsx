import Link from 'next/link';
import {
  apiFetch,
  RequestOfferPreview,
  statusLabel,
  statusBadgeClass,
  formatPrice,
  formatDate,
  formatDateTime,
} from '../../../../lib/api';

type RequestOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RequestOffersPage({ params }: RequestOffersPageProps) {
  const { id } = await params;
  const offers = await apiFetch<RequestOfferPreview[]>(`/service-requests/${id}/offers`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/requests/my">Taleplerim</Link>
        <span aria-hidden="true">/</span>
        <span>Talep Teklifleri</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Talep Teklifleri</h1>
        <p className="page-subtitle">
          Hizmet verenlerin gönderdiği teklifler. Ödeme ve doğrudan iletişim sonraki fazda devreye girecektir.
        </p>
      </header>

      {offers.length === 0 ? (
        <div className="empty-state">
          <h2>Henüz teklif yok</h2>
          <p className="muted">Talebiniz için henüz hizmet veren teklif vermemiş. Birazdan tekrar bakın.</p>
        </div>
      ) : null}

      <div className="list-stack">
        {offers.map((offer) => (
          <article className="list-card" key={offer.id}>
            <div className="list-card-header">
              <div>
                <h2 className="list-card-title">{offer.provider.businessName}</h2>
                <p className="list-card-meta">
                  <span>{offer.provider.city}/{offer.provider.district}</span>
                  <span>Başlangıç: {offer.estimatedStartDate ? formatDate(offer.estimatedStartDate) : '-'}</span>
                  <span>Bitiş: {offer.estimatedCompletionDate ? formatDate(offer.estimatedCompletionDate) : '-'}</span>
                  <span>Gönderim: {formatDateTime(offer.submittedAt)}</span>
                </p>
              </div>
              <div className="inline-actions">
                <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
                <span className="badge">{formatPrice(offer.priceAmount, offer.currency)}</span>
              </div>
            </div>
            <p style={{ margin: 0 }}>{offer.message}</p>
            {offer.warrantyNote ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Garanti notu: {offer.warrantyNote}
              </p>
            ) : null}
            <div className="inline-actions">
              <Link className="btn btn-primary btn-sm" href={`/requests/${id}/offers/${offer.id}`}>
                Teklifi İncele
              </Link>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
