import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  ProviderProfile,
  statusLabel,
} from '../../../lib/api';
import { ProviderShell } from '../provider-shell';
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

  const provider = await apiFetch<ProviderProfile>(`/providers/${id}`);

  return (
    <ProviderShell user={user} providerId={provider.id} businessName={provider.businessName} active="profile">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Profil</span>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">{provider.businessName}</h1>
        <p className="pdash-page-sub">
          <span className={providerStatusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
          <span style={{ marginLeft: 8 }}>· {provider.city}/{provider.district}</span>
        </p>
        <div className="pdash-page-actions">
          {provider.status === 'APPROVED' ? (
            <>
              <Link className="pdash-btn pdash-btn-primary" href={`/providers/${provider.id}/requests`}>
                Uygun Talepler
              </Link>
              <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${provider.id}/offers`}>
                Tekliflerim
              </Link>
              <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${provider.id}/credits`}>
                Kredilerim
              </Link>
            </>
          ) : null}
          <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${provider.id}/edit`}>
            Profili Düzenle
          </Link>
        </div>
      </header>

      <div className="pdash-detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card">
            <h2>Hakkında</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Yetkili</dt>
                <dd>{provider.contactName}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Konum</dt>
                <dd>{provider.city}/{provider.district}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Açıklama</dt>
                <dd>{provider.description ?? '-'}</dd>
              </div>
            </dl>
          </section>

          <section className="pdash-detail-card">
            <h2>Hizmet Kategorileri</h2>
            <div className="pdash-chip-list">
              {provider.serviceCategories.length === 0 ? (
                <span className="pdash-card-sub">Kategori seçilmemiş.</span>
              ) : (
                provider.serviceCategories.map((item) => (
                  <span className="pdash-chip pdash-chip-info" key={item.id}>
                    {item.category.name}
                  </span>
                ))
              )}
            </div>
          </section>

          <section className="pdash-detail-card">
            <h2>Hizmet Bölgeleri</h2>
            <div className="pdash-chip-list">
              {provider.serviceAreas.length === 0 ? (
                <span className="pdash-card-sub">Bölge tanımlı değil.</span>
              ) : (
                provider.serviceAreas.map((area) => (
                  <span className="pdash-chip" key={area.id}>
                    {area.city}
                    {area.district ? `/${area.district}` : ''}
                    {area.neighborhood ? `/${area.neighborhood}` : ''}
                  </span>
                ))
              )}
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card">
            <h2>İletişim</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Telefon</dt>
                <dd>{provider.phone}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>E-posta</dt>
                <dd>{provider.email ?? '-'}</dd>
              </div>
              {provider.addressNote ? (
                <div className="pdash-info-row">
                  <dt>Adres notu</dt>
                  <dd>{provider.addressNote}</dd>
                </div>
              ) : null}
            </dl>
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
      </div>
    </ProviderShell>
  );
}
