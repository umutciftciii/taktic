import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  formatPrice,
  getCurrentUser,
  ProviderDashboard,
  ProviderOffer,
  ProviderRequestListItem,
  statusLabel,
  urgencyLabel,
} from '../../../lib/api';
import { CategoryVisual } from '../../category-visual';
import { IconArrowRight } from '../../landing-icons';
import { ProviderShell } from '../provider-shell';
import { providerOfferStatusLabel, providerStatusBadgeClass } from '../provider-ui';

export default async function MyProviderPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'PROVIDER') {
    redirect('/login?redirectTo=/providers/me');
  }

  const dashboard = await apiFetch<ProviderDashboard>('/providers/me/dashboard');
  const provider = dashboard.provider;

  if (!provider) {
    return (
      <ProviderShell user={user} active="dashboard">
        <header className="pdash-page-head">
          <h1 className="pdash-page-title">Hizmet Veren Paneli</h1>
          <p className="pdash-page-sub">
            Talep eşleşmelerini ve teklif akışını kullanmak için önce profilinizi tamamlayın.
          </p>
        </header>

        <div className="pdash-empty">
          <h3>Henüz hizmet veren profiliniz yok</h3>
          <p>
            Eşleşen talepleri görmek ve teklif vermek için hizmet veren profilinizi oluşturmanız
            gerekiyor.
          </p>
          <Link className="pdash-btn pdash-btn-primary" href="/providers/register">
            Hizmet Veren Profili Oluştur
          </Link>
        </div>
      </ProviderShell>
    );
  }

  const canUseOfferFlow = provider.status === 'APPROVED';
  const creditBalance = dashboard.creditBalance ?? 0;
  const activeOffers = dashboard.activeOffersCount ?? 0;
  const totalOffers = dashboard.recentOffersCount ?? 0;
  const matchingRequests = dashboard.matchingApprovedRequestsCount ?? 0;

  /*
   * The opportunity and offer lists are the same data the dedicated screens
   * show, read from the same routes. A provider whose profile is not approved
   * yet cannot list matching requests, so that call is not even made.
   */
  const [opportunities, recentOffers] = await Promise.all([
    canUseOfferFlow ? safeList<ProviderRequestListItem>(`/providers/${provider.id}/requests`) : [],
    safeList<ProviderOffer>(`/providers/${provider.id}/offers`),
  ]);

  return (
    <ProviderShell
      user={user}
      providerId={provider.id}
      businessName={provider.businessName}
      active="dashboard"
      creditBalance={creditBalance}
      status={provider.status}
      counts={{ requests: matchingRequests, offers: activeOffers }}
    >
      <header className="pdash-page-head">
        <div className="panel-head-row">
          <div>
            <span className="kicker">Panelim</span>
            <h1 className="pdash-page-title">{provider.businessName}</h1>
            <p className="pdash-page-sub">
              <span className={providerStatusBadgeClass(provider.status)}>
                {statusLabel(provider.status)}
              </span>{' '}
              · {provider.city}/{provider.district}
              {canUseOfferFlow ? (
                <>
                  {' '}
                  · Bölgende{' '}
                  <strong>{matchingRequests}</strong> uygun talep var.
                </>
              ) : null}
            </p>
          </div>
          {canUseOfferFlow ? (
            <Link className="pdash-btn pdash-btn-primary" href={`/providers/${provider.id}/requests`}>
              Uygun talepleri gör
              <IconArrowRight size={12} />
            </Link>
          ) : null}
        </div>
      </header>

      <ProviderStatusNotice provider={provider} />

      <section className="metric-strip" aria-label="Özet">
        <div className="metric-cell">
          <span className="metric-label">Kredi bakiyesi</span>
          <span className="metric-value">{creditBalance}</span>
          <span className="metric-hint">teklif maliyeti kategoriye göre değişir</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Uygun talep</span>
          <span className="metric-value">{matchingRequests}</span>
          <span className="metric-hint">bölgene ve kategorine uyan</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Bekleyen teklif</span>
          <span className="metric-value">{activeOffers}</span>
          <span className="metric-hint">henüz sonuçlanmadı</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Toplam teklif</span>
          <span className="metric-value">{totalOffers}</span>
          <span className="metric-hint">son dönem</span>
        </div>
      </section>

      <div className="split">
        <div className="split-main">
          <div className="pdash-section-head">
            <h2 className="pdash-section-title">
              <span>Yeni fırsatlar</span>
              <span className="pdash-section-count">{opportunities.length}</span>
            </h2>
            {canUseOfferFlow ? (
              <Link className="btn btn-ghost btn-sm" href={`/providers/${provider.id}/requests`}>
                Tümünü gör
                <IconArrowRight size={12} />
              </Link>
            ) : null}
          </div>

          {opportunities.length === 0 ? (
            <div className="pdash-empty">
              <h3>Şu an uygun talep yok</h3>
              <p>
                {canUseOfferFlow
                  ? 'Bölgene ve kategorilerine uyan yeni bir talep geldiğinde burada görünecek.'
                  : 'Profilin onaylandıktan sonra eşleşen talepler burada listelenir.'}
              </p>
            </div>
          ) : (
            <div className="rowlist">
              {opportunities.slice(0, 3).map((request) => (
                <article className="datarow" key={request.id}>
                  <span className="datarow-media">
                    <CategoryVisual
                      slug={request.category.slug}
                      name={request.category.name}
                      iconSize={24}
                      alt=""
                    />
                  </span>
                  <div className="datarow-body">
                    <h3 className="datarow-title">
                      <span>{request.category.name}</span>
                      <span className="tag tag-accent">Kalite {request.qualityScore}</span>
                    </h3>
                    <p className="datarow-meta">
                      <span>
                        {request.city}/{request.district}
                      </span>
                      {request.urgency ? <span>{urgencyLabel(request.urgency)}</span> : null}
                      <span>{formatDateTime(request.submittedAt)}</span>
                    </p>
                  </div>
                  <div className="datarow-stat">
                    <span className="datarow-stat-label">Teklif kredisi</span>
                    <span className="datarow-stat-value">
                      {request.canOffer && request.offerCreditCost !== null
                        ? `${request.offerCreditCost}`
                        : '—'}
                    </span>
                  </div>
                  <div className="datarow-actions">
                    <Link
                      className="pdash-btn pdash-btn-primary pdash-btn-sm"
                      href={`/providers/${provider.id}/requests/${request.id}`}
                    >
                      Teklif ver
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="pdash-section-head">
            <h2 className="pdash-section-title">
              <span>Son teklifler</span>
              <span className="pdash-section-count">{recentOffers.length}</span>
            </h2>
            <Link className="btn btn-ghost btn-sm" href={`/providers/${provider.id}/offers`}>
              Tekliflerim
              <IconArrowRight size={12} />
            </Link>
          </div>

          {recentOffers.length === 0 ? (
            <div className="pdash-empty">
              <h3>Henüz teklif vermediniz</h3>
              <p>Eşleşen talepleri inceleyip ilk teklifinizi gönderebilirsiniz.</p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="pdash-table">
                <thead>
                  <tr>
                    <th>Talep</th>
                    <th>Tutar</th>
                    <th>Durum</th>
                    <th>Tarih</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOffers.slice(0, 5).map((offer) => (
                    <tr key={offer.id}>
                      <td>
                        {offer.request.category.name}
                        <div className="pdash-card-sub">
                          {offer.request.city}/{offer.request.district}
                        </div>
                      </td>
                      <td>{formatPrice(offer.priceAmount, offer.currency)}</td>
                      <td>
                        <span className={providerStatusBadgeClass(offer.status)}>
                          {providerOfferStatusLabel(offer.status)}
                        </span>
                      </td>
                      <td>{formatDateTime(offer.submittedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="split-rail" aria-label="Kısayollar">
          <div className="rail-panel">
            <span className="rail-title">Hızlı işlemler</span>
            <Link className="pdash-btn pdash-btn-secondary pdash-btn-block" href={`/providers/${provider.id}/offers`}>
              Tekliflerim
            </Link>
            <Link className="pdash-btn pdash-btn-secondary pdash-btn-block" href={`/providers/${provider.id}/credits`}>
              Krediler ve paketler
            </Link>
            <Link className="pdash-btn pdash-btn-secondary pdash-btn-block" href={`/providers/${provider.id}`}>
              İşletme profili
            </Link>
          </div>

          <div className="rail-note">
            <strong>İade taraması.</strong> Görüntülenmeyen veya geçersiz hale gelen talepler için
            iade uygunluğu otomatik taranır; sonucu her teklifin detayında görebilirsin.
          </div>

          <div className="rail-note">
            <strong>Bütçe aralıkları.</strong> Talep listelerinde görünen bütçe, müşterinin kendi
            belirttiği aralıktır; bir aralık verilmemişse boş görünür.
          </div>
        </aside>
      </div>
    </ProviderShell>
  );
}

/** A list the dashboard can live without: a failure renders as "nothing yet". */
async function safeList<T>(path: string): Promise<T[]> {
  try {
    return await apiFetch<T[]>(path);
  } catch {
    return [];
  }
}

function ProviderStatusNotice({ provider }: { provider: NonNullable<ProviderDashboard['provider']> }) {
  if (provider.status === 'PENDING_REVIEW') {
    return (
      <div className="pdash-notice">
        Başvurunuz inceleniyor. Onaylandıktan sonra uygun taleplere teklif verebilirsiniz.
      </div>
    );
  }

  if (provider.status === 'REJECTED') {
    return (
      <div className="pdash-notice pdash-notice-error">
        Başvurunuz reddedildi. Sebep: {provider.rejectionReason ?? '-'}
      </div>
    );
  }

  if (provider.status === 'SUSPENDED') {
    return (
      <div className="pdash-notice pdash-notice-warn">
        Profiliniz askıya alındı. Bu durumda teklif akışı kullanılamaz.
      </div>
    );
  }

  return null;
}
