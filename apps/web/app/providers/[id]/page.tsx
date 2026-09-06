import { serviceAreaLabel } from '@taktic/shared';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  ProviderOffer,
  ProviderProfile,
  statusLabel,
} from '../../../lib/api';
import { ProviderShell } from '../provider-shell';
import { readCreditBalance } from '../provider-data';
import { providerStatusBadgeClass } from '../provider-ui';

type ProviderPreviewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderPreviewPage({ params }: ProviderPreviewPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}`);
  }

  const provider = await fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`));

  // This screen is the provider's own profile inside their panel, so it needs
  // the private projection. Anyone else gets the public business card back and
  // has no business on this route.
  if (provider.visibility === 'public') {
    notFound();
  }

  const [offers, creditBalance] = await Promise.all([
    safeOffers(id),
    readCreditBalance(id),
  ]);

  /*
   * The rail's figures are counted from this provider's own offers. Anything
   * the platform does not record — an average response time, a rating — is not
   * shown at all rather than filled in.
   */
  const totalOffers = offers.length;
  const wonOffers = offers.filter((offer) => offer.status === 'ACCEPTED').length;
  const winRate = totalOffers > 0 ? Math.round((wonOffers / totalOffers) * 100) : null;

  return (
    <ProviderShell
      user={user}
      providerId={provider.id}
      businessName={provider.businessName}
      active="profile"
      creditBalance={creditBalance}
      status={provider.status}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>İşletme profili</span>
      </nav>

      <header className="pdash-page-head">
        <div className="panel-head-row">
          <div>
            <span className="kicker">İşletme profili</span>
            <h1 className="pdash-page-title">{provider.businessName}</h1>
            <p className="pdash-page-sub">
              <span className={providerStatusBadgeClass(provider.status)}>
                {statusLabel(provider.status)}
              </span>{' '}
              · {provider.city}/{provider.district}
            </p>
          </div>
          <Link className="pdash-btn pdash-btn-primary" href={`/providers/${provider.id}/edit`}>
            Profili düzenle
          </Link>
        </div>
      </header>

      <div className="split">
        <div className="split-main">
          <section className="pdash-detail-card">
            <h2>İşletme bilgileri</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Yetkili</dt>
                <dd>{provider.contactName}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Telefon</dt>
                <dd>{provider.phone}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>E-posta</dt>
                <dd>{provider.email ?? '-'}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Merkez</dt>
                <dd>
                  {provider.city}/{provider.district}
                </dd>
              </div>
              {provider.addressNote ? (
                <div className="pdash-info-row">
                  <dt>Adres notu</dt>
                  <dd>{provider.addressNote}</dd>
                </div>
              ) : null}
              <div className="pdash-info-row">
                <dt>Tanıtım</dt>
                <dd>{provider.description ?? '-'}</dd>
              </div>
            </dl>
          </section>

          <section className="pdash-detail-card">
            <h2>Hizmet kapsamı</h2>
            <div className="pdash-chip-list">
              {provider.serviceCategories.length === 0 ? (
                <span className="pdash-card-sub">Kategori seçilmemiş.</span>
              ) : (
                provider.serviceCategories.map((item) => (
                  <span className="tag tag-accent" key={item.id}>
                    {item.category.name}
                  </span>
                ))
              )}
            </div>

            {/*
              The services this provider joined before the marketplace released
              them. Its own block rather than a badge in the list above, because
              the two behave differently: one brings requests today and the other
              brings none at all, and a chip that looked the same would read as
              "no requests yet" instead of "not open yet".

              One sentence and no numbers. How many businesses stand behind an
              unreleased service, and how close it is to launching, is the
              operator's panel — nothing about a provider joining one makes that
              figure theirs.
            */}
            {(provider.upcomingServiceCategories ?? []).length > 0 ? (
              <>
                <h2 style={{ marginTop: 8 }}>Yakında açılacak hizmetlerim</h2>
                <div className="pdash-chip-list" data-testid="upcoming-service-categories">
                  {provider.upcomingServiceCategories!.map((item) => (
                    <span className="tag tag-neutral" key={item.id}>
                      {item.category.name}
                    </span>
                  ))}
                </div>
                <span className="pdash-card-sub">
                  Yakında açılacak — henüz talep alamaz.
                </span>
              </>
            ) : null}

            <h2 style={{ marginTop: 8 }}>Hizmet bölgeleri</h2>
            <div className="pdash-chip-list">
              {provider.serviceAreas.length === 0 ? (
                <span className="pdash-card-sub">Bölge tanımlı değil.</span>
              ) : (
                provider.serviceAreas.map((area) => (
                  <span className="tag tag-neutral" key={area.id}>
                    {serviceAreaLabel(area)}
                  </span>
                ))
              )}
            </div>
          </section>

          {provider.status === 'REJECTED' && provider.rejectionReason ? (
            <div className="pdash-notice pdash-notice-error">
              Başvuru reddedildi. Sebep: {provider.rejectionReason}
            </div>
          ) : null}

          {provider.status === 'SUSPENDED' ? (
            <div className="pdash-notice pdash-notice-warn">
              Profil askıya alındı. Teklif akışı kullanılamaz.
            </div>
          ) : null}
        </div>

        <aside className="split-rail" aria-label="İşletme kartı">
          <div className="rail-panel">
            <span className="avatar-sq" style={{ width: 68, height: 68, fontSize: 22 }} aria-hidden="true">
              {getInitials(provider.businessName)}
            </span>
            <div>
              <div className="pdash-brand-title">{provider.businessName}</div>
              <div className="pdash-brand-sub">
                {provider.city}/{provider.district}
              </div>
            </div>
            <div>
              <span className={provider.status === 'APPROVED' ? 'tag tag-ink' : 'tag tag-neutral'}>
                {provider.status === 'APPROVED' ? 'Onaylı işletme' : statusLabel(provider.status)}
              </span>
            </div>

            <div className="metric-strip" style={{ margin: '8px 0 0' }}>
              <div className="metric-cell" style={{ padding: 16 }}>
                <span className="metric-label">Teklif</span>
                <span className="metric-value" style={{ fontSize: 24 }}>
                  {totalOffers}
                </span>
              </div>
              <div className="metric-cell" style={{ padding: 16 }}>
                <span className="metric-label">Kazanılan</span>
                <span className="metric-value" style={{ fontSize: 24 }}>
                  {wonOffers}
                </span>
              </div>
              <div className="metric-cell" style={{ padding: 16 }}>
                <span className="metric-label">Kazanma</span>
                <span className="metric-value" style={{ fontSize: 24 }}>
                  {winRate === null ? '—' : `%${winRate}`}
                </span>
              </div>
              <div className="metric-cell" style={{ padding: 16 }}>
                <span className="metric-label">Kategori</span>
                <span className="metric-value" style={{ fontSize: 24 }}>
                  {/*
                    Live categories only. An unreleased one brings no request, so
                    counting it here would promise matches that cannot come.
                  */}
                  {provider.serviceCategories.length}
                </span>
              </div>
            </div>
          </div>

          <div className="rail-note">
            <strong>Profilini güçlendir.</strong> Tanıtım metnini doldur, hizmet kategorilerini ve
            bölgelerini güncel tut: eşleşme bu iki alana göre yapılır.
          </div>
        </aside>
      </div>
    </ProviderShell>
  );
}

/** The rail can live without the offer list; a failure just hides the numbers. */
async function safeOffers(providerId: string): Promise<ProviderOffer[]> {
  try {
    return await apiFetch<ProviderOffer[]>(`/providers/${providerId}/offers`);
  } catch {
    return [];
  }
}

function getInitials(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'H';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'H';
}
