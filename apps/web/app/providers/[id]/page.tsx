import Link from 'next/link';
import { apiFetch, ProviderProfile, statusLabel, statusBadgeClass } from '../../../lib/api';

type ProviderPreviewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderPreviewPage({ params }: ProviderPreviewPageProps) {
  const { id } = await params;
  const provider = await apiFetch<ProviderProfile>(`/providers/${id}`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Ana sayfa</Link>
        <span aria-hidden="true">/</span>
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Profil</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{provider.businessName}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>{' '}
          <span className="muted">· {provider.city}/{provider.district}</span>
        </p>
      </header>

      <div className="inline-actions" style={{ marginBottom: 18 }}>
        {provider.status === 'APPROVED' ? (
          <>
            <Link className="btn btn-primary" href={`/providers/${provider.id}/requests`}>Uygun Talepler</Link>
            <Link className="btn btn-secondary" href={`/providers/${provider.id}/offers`}>Tekliflerim</Link>
            <Link className="btn btn-secondary" href={`/providers/${provider.id}/credits`}>Kredilerim</Link>
          </>
        ) : null}
        <Link className="btn btn-ghost" href={`/providers/${provider.id}/edit`}>Profili düzenle</Link>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Hakkında</h2>
            <dl className="meta-row">
              <dt>Yetkili</dt>
              <dd>{provider.contactName}</dd>
              <dt>Konum</dt>
              <dd>{provider.city}/{provider.district}</dd>
              <dt>Açıklama</dt>
              <dd>{provider.description ?? '-'}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Kategoriler</h2>
            <div className="inline-actions">
              {provider.serviceCategories.length === 0 ? (
                <span className="muted">Kategori seçilmemiş.</span>
              ) : (
                provider.serviceCategories.map((item) => (
                  <span className="badge badge-info" key={item.id}>{item.category.name}</span>
                ))
              )}
            </div>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Hizmet Bölgeleri</h2>
            <div className="inline-actions">
              {provider.serviceAreas.length === 0 ? (
                <span className="muted">Bölge tanımlı değil.</span>
              ) : (
                provider.serviceAreas.map((area) => (
                  <span className="badge badge-muted" key={area.id}>
                    {area.city}
                    {area.district ? `/${area.district}` : ''}
                    {area.neighborhood ? `/${area.neighborhood}` : ''}
                  </span>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>İletişim</h2>
            <dl className="meta-row">
              <dt>Telefon</dt>
              <dd>{provider.phone}</dd>
              <dt>E-posta</dt>
              <dd>{provider.email ?? '-'}</dd>
            </dl>
          </section>
        </div>
      </div>
    </main>
  );
}
