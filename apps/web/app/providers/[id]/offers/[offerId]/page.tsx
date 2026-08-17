import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  ProviderOffer,
  refundActionLabel,
  formatPrice,
  formatDateTime,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import {
  providerOfferStatusLabel,
  providerRefundBadgeClass,
  providerStatusBadgeClass,
} from '../../../provider-ui';

type ProviderOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
};

export default async function ProviderOfferDetailPage({ params }: ProviderOfferDetailPageProps) {
  const { id, offerId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/offers/${offerId}`);
  }

  const offer = await apiFetch<ProviderOffer>(`/providers/${id}/offers/${offerId}`);

  return (
    <ProviderShell user={user} providerId={id} active="offers">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/offers`}>Tekliflerim</Link>
        <span aria-hidden="true">/</span>
        <span>Teklif Detayı</span>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">Teklif Detayı</h1>
        <p className="pdash-page-sub">
          {offer.request.category.name} · {offer.request.city}/{offer.request.district}
          <span style={{ marginLeft: 8 }}>
            <span className={providerStatusBadgeClass(offer.status)}>{providerOfferStatusLabel(offer.status)}</span>
          </span>
        </p>
      </header>

      <div className="pdash-detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card">
            <h2>Özet</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Fiyat</dt>
                <dd>
                  <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Durum</dt>
                <dd>
                  <span className={providerStatusBadgeClass(offer.status)}>{providerOfferStatusLabel(offer.status)}</span>
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Gönderim</dt>
                <dd>{formatDateTime(offer.submittedAt)}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Talep kategorisi</dt>
                <dd>{offer.request.category.name}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Talep konumu</dt>
                <dd>
                  {offer.request.city}/{offer.request.district}
                </dd>
              </div>
            </dl>
          </section>

          <section className="pdash-detail-card">
            <h2>Mesaj</h2>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
              {offer.message}
            </p>
            {offer.warrantyNote ? (
              <>
                <h3>Garanti notu</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
                  {offer.warrantyNote}
                </p>
              </>
            ) : null}
            {offer.internalNote ? (
              <>
                <h3>İç not</h3>
                <p
                  style={{
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  {offer.internalNote}
                </p>
              </>
            ) : null}
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card">
            <h2>Kredi ve İade</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Kullanılan kredi</dt>
                <dd>{offer.creditCost}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Harcama işlem</dt>
                <dd>{offer.creditSpentTransactionId ?? '-'}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>İade tarihi</dt>
                <dd>
                  {offer.creditRefundedAt
                    ? `${formatDateTime(offer.creditRefundedAt)} — ${offer.creditRefundReason ?? '-'}`
                    : 'Yok'}
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Öneri</dt>
                <dd>
                  <span className={providerRefundBadgeClass(offer.refundEligibility.recommendedAction)}>
                    {refundActionLabel(offer.refundEligibility.recommendedAction)}
                  </span>
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Neden</dt>
                <dd>{offer.refundEligibility.reasonLabel}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Detay</dt>
                <dd style={{ color: 'var(--muted)', fontSize: 13 }}>{offer.refundEligibility.details}</dd>
              </div>
            </dl>
          </section>

          <div className="pdash-notice">
            Bu fazda müşteriyle iletişim ve ödeme akışı henüz aktif değildir.
          </div>

          <div className="pdash-actions">
            <Link
              className="pdash-btn pdash-btn-secondary"
              href={`/providers/${id}/requests/${offer.request.id}`}
            >
              Talep Detayı
            </Link>
            <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/offers`}>
              Tüm Tekliflerim
            </Link>
          </div>
        </div>
      </div>
    </ProviderShell>
  );
}
