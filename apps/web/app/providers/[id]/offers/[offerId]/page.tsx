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
} from '../../../../../lib/api';

type ProviderOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
};

export default async function ProviderOfferDetailPage({ params }: ProviderOfferDetailPageProps) {
  const { id, offerId } = await params;
  const offer = await apiFetch<ProviderOffer>(`/providers/${id}/offers/${offerId}`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/offers`}>Tekliflerim</Link>
        <span aria-hidden="true">/</span>
        <span>Teklif detayı</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Teklif Detayı</h1>
        <p className="page-subtitle">
          {offer.request.category.name} · {offer.request.city}/{offer.request.district} ·{' '}
          <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
        </p>
      </header>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Özet</h2>
            <dl className="meta-row">
              <dt>Fiyat</dt>
              <dd><strong>{formatPrice(offer.priceAmount, offer.currency)}</strong></dd>
              <dt>Durum</dt>
              <dd><span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span></dd>
              <dt>Gönderim</dt>
              <dd>{formatDateTime(offer.submittedAt)}</dd>
              <dt>Talep kategorisi</dt>
              <dd>{offer.request.category.name}</dd>
              <dt>Talep konumu</dt>
              <dd>{offer.request.city}/{offer.request.district}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Mesaj</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{offer.message}</p>
            {offer.warrantyNote ? (
              <>
                <h3 style={{ marginTop: 14, fontSize: 14 }}>Garanti notu</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{offer.warrantyNote}</p>
              </>
            ) : null}
            {offer.internalNote ? (
              <>
                <h3 style={{ marginTop: 14, fontSize: 14 }}>İç not</h3>
                <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{offer.internalNote}</p>
              </>
            ) : null}
          </section>
        </div>

        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Kredi ve İade</h2>
            <dl className="meta-row">
              <dt>Kullanılan kredi</dt>
              <dd>{offer.creditCost}</dd>
              <dt>Harcama işlem</dt>
              <dd>{offer.creditSpentTransactionId ?? '-'}</dd>
              <dt>İade tarihi</dt>
              <dd>
                {offer.creditRefundedAt
                  ? `${formatDateTime(offer.creditRefundedAt)} — ${offer.creditRefundReason ?? '-'}`
                  : 'Yok'}
              </dd>
              <dt>Öneri</dt>
              <dd>
                <span className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}>
                  {refundActionLabel(offer.refundEligibility.recommendedAction)}
                </span>
              </dd>
              <dt>Neden</dt>
              <dd>{offer.refundEligibility.reasonLabel}</dd>
              <dt>Detay</dt>
              <dd className="muted" style={{ fontSize: 13 }}>{offer.refundEligibility.details}</dd>
            </dl>
          </section>

          <div className="notice">
            Bu fazda müşteriyle iletişim ve ödeme akışı henüz aktif değildir.
          </div>
        </div>
      </div>
    </main>
  );
}
