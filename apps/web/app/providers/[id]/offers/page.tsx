import Link from 'next/link';
import {
  apiFetch,
  ProviderOffer,
  statusLabel,
  statusBadgeClass,
  refundActionLabel,
  refundActionBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../../../lib/api';

type ProviderOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderOffersPage({ params }: ProviderOffersPageProps) {
  const { id } = await params;
  const offers = await apiFetch<ProviderOffer[]>(`/providers/${id}/offers`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}`}>Profil</Link>
        <span aria-hidden="true">/</span>
        <span>Tekliflerim</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Tekliflerim</h1>
        <p className="page-subtitle">Verdiğiniz teklifler ve kredi durumları.</p>
      </header>

      {offers.length === 0 ? (
        <div className="empty-state">
          <h2>Henüz teklif vermediniz</h2>
          <p className="muted">Eşleşen talepleri inceleyip ilk teklifinizi gönderebilirsiniz.</p>
          <Link className="btn btn-primary" href={`/providers/${id}/requests`} style={{ marginTop: 8 }}>
            Eşleşen talepleri gör
          </Link>
        </div>
      ) : null}

      <div className="list-stack">
        {offers.map((offer) => (
          <article className="list-card" key={offer.id}>
            <div className="list-card-header">
              <div>
                <h2 className="list-card-title">{offer.request.category.name}</h2>
                <p className="list-card-meta">
                  <span>{offer.request.city}/{offer.request.district}</span>
                  <span>Gönderim: {formatDateTime(offer.submittedAt)}</span>
                </p>
              </div>
              <div className="inline-actions">
                <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
              </div>
            </div>

            <dl className="meta-row">
              <dt>Fiyat</dt>
              <dd><strong>{formatPrice(offer.priceAmount, offer.currency)}</strong></dd>
              <dt>Kullanılan kredi</dt>
              <dd>{offer.creditCost}</dd>
              <dt>İade durumu</dt>
              <dd>
                {offer.creditRefundedAt
                  ? `İade edildi · ${formatDateTime(offer.creditRefundedAt)}`
                  : 'Henüz iade yok'}
              </dd>
              <dt>İade önerisi</dt>
              <dd>
                <span className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}>
                  {refundActionLabel(offer.refundEligibility.recommendedAction)}
                </span>
              </dd>
            </dl>

            <div className="inline-actions">
              <Link className="btn btn-secondary btn-sm" href={`/providers/${id}/offers/${offer.id}`}>
                Teklif detayı
              </Link>
              <Link className="btn btn-ghost btn-sm" href={`/providers/${id}/requests/${offer.request.id}`}>
                Talep detayı
              </Link>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
