import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  ProviderOffer,
  statusLabel,
  refundActionLabel,
  formatPrice,
  formatDateTime,
} from '../../../../lib/api';
import { ProviderShell } from '../../provider-shell';
import { providerRefundBadgeClass, providerStatusBadgeClass } from '../../provider-ui';

type ProviderOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderOffersPage({ params }: ProviderOffersPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/offers`);
  }

  const offers = await apiFetch<ProviderOffer[]>(`/providers/${id}/offers`);

  const counts = offers.reduce(
    (acc, offer) => {
      acc.total += 1;
      if (offer.status === 'ACCEPTED') acc.accepted += 1;
      else if (
        offer.status === 'SUBMITTED' ||
        offer.status === 'VIEWED' ||
        offer.status === 'SHORTLISTED'
      ) {
        acc.pending += 1;
      } else if (
        offer.status === 'REJECTED' ||
        offer.status === 'WITHDRAWN' ||
        offer.status === 'EXPIRED' ||
        offer.status === 'CANCELLED'
      ) {
        acc.closed += 1;
      }
      return acc;
    },
    { total: 0, pending: 0, accepted: 0, closed: 0 },
  );

  return (
    <ProviderShell user={user} providerId={id} active="offers">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Tekliflerim</span>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">Tekliflerim</h1>
        <p className="pdash-page-sub">Gönderdiğiniz tüm teklifleri ve durumlarını buradan izleyin.</p>
      </header>

      <section className="pdash-stat-grid" aria-label="Teklif özetleri">
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Toplam Teklif</span>
          <span className="pdash-stat-value">{counts.total}</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Bekleyen</span>
          <span className="pdash-stat-value">{counts.pending}</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Onaylanan</span>
          <span className="pdash-stat-value">{counts.accepted}</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Kapanan</span>
          <span className="pdash-stat-value">{counts.closed}</span>
        </div>
      </section>

      {offers.length === 0 ? (
        <div className="pdash-empty">
          <h3>Henüz teklif vermediniz</h3>
          <p>Eşleşen talepleri inceleyip ilk teklifinizi gönderebilirsiniz.</p>
          <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/requests`}>
            Uygun Talepleri Gör
          </Link>
        </div>
      ) : (
        <>
          <div className="pdash-section-head">
            <h2 className="pdash-section-title">
              Gönderilen Teklifler
              <span className="pdash-section-count">{offers.length}</span>
            </h2>
          </div>
          <div className="pdash-grid">
            {offers.map((offer) => (
              <article className="pdash-card" key={offer.id}>
                <div className="pdash-card-head">
                  <div style={{ minWidth: 0 }}>
                    <h3 className="pdash-card-title">{offer.request.category.name}</h3>
                    <p className="pdash-card-sub">
                      {offer.request.city}/{offer.request.district}
                    </p>
                    <p
                      className="pdash-card-sub"
                      style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 2 }}
                    >
                      {offer.offerNumber ?? `#${offer.id.slice(-6).toUpperCase()}`}
                      <span style={{ color: 'var(--muted)' }}> · Talep: </span>
                      {offer.request.requestNumber ??
                        `#${offer.request.id.slice(-6).toUpperCase()}`}
                    </p>
                  </div>
                  <span className={providerStatusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
                </div>

                <div className="pdash-card-meta">
                  <span>📅 Gönderim: {formatDateTime(offer.submittedAt)}</span>
                  <span>🪙 Kullanılan kredi: {offer.creditCost}</span>
                  <span>
                    🔁 İade:{' '}
                    {offer.creditRefundedAt
                      ? `${formatDateTime(offer.creditRefundedAt)}`
                      : 'Henüz yok'}
                  </span>
                  <span>
                    📌 Politika:{' '}
                    <span className={providerRefundBadgeClass(offer.refundEligibility.recommendedAction)}>
                      {refundActionLabel(offer.refundEligibility.recommendedAction)}
                    </span>
                  </span>
                </div>

                <div className="pdash-card-foot">
                  <div>
                    <div className="pdash-card-price-label">Teklif</div>
                    <div className="pdash-card-price">{formatPrice(offer.priceAmount, offer.currency)}</div>
                  </div>
                  <div className="pdash-actions">
                    <Link
                      className="pdash-btn pdash-btn-secondary pdash-btn-sm"
                      href={`/providers/${id}/requests/${offer.request.id}`}
                    >
                      Talep
                    </Link>
                    <Link
                      className="pdash-btn pdash-btn-primary pdash-btn-sm"
                      href={`/providers/${id}/offers/${offer.id}`}
                    >
                      Teklif Detayı
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </ProviderShell>
  );
}
