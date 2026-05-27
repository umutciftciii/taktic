import Link from 'next/link';
import {
  apiFetch,
  ProviderProfile,
  ProviderStatus,
  statusLabel,
  statusBadgeClass,
  formatDateTime,
} from '../../../lib/api';
import { updateProviderStatusAction } from '../actions';

const statuses: ProviderStatus[] = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];

type ProviderDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderDetailPage({ params }: ProviderDetailPageProps) {
  const { id } = await params;
  const provider = await apiFetch<ProviderProfile>(`/providers/${id}`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href="/providers">Hizmet Verenler</Link>
        <span aria-hidden="true">/</span>
        <span>Detay</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{provider.businessName}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>{' '}
          <span className="muted">· {provider.city}/{provider.district}</span>
        </p>
      </header>

      <div className="inline-actions" style={{ marginBottom: 18 }}>
        <Link className="btn btn-secondary btn-sm" href={`/offers?providerId=${provider.id}`}>Teklifler</Link>
        <Link className="btn btn-secondary btn-sm" href={`/providers/${provider.id}/credits`}>Krediler</Link>
        <Link className="btn btn-ghost btn-sm" href={`/package-purchases?providerId=${provider.id}`}>
          Paket talepleri
        </Link>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Profil</h2>
            <dl className="meta-row">
              <dt>Hizmet veren ID</dt>
              <dd><code style={{ fontSize: 12 }}>{provider.id}</code></dd>
              <dt>Yetkili</dt>
              <dd>{provider.contactName}</dd>
              <dt>Telefon</dt>
              <dd>{provider.phone}</dd>
              <dt>E-posta</dt>
              <dd>{provider.email ?? '-'}</dd>
              <dt>Bağlı hesap</dt>
              <dd>{provider.user?.email ?? '-'}</dd>
              <dt>Konum</dt>
              <dd>{provider.city}/{provider.district}</dd>
              <dt>Adres notu</dt>
              <dd>{provider.addressNote ?? '-'}</dd>
              <dt>Açıklama</dt>
              <dd>{provider.description ?? '-'}</dd>
              <dt>Onay</dt>
              <dd>{provider.approvedAt ? formatDateTime(provider.approvedAt) : '-'}</dd>
              <dt>Ret</dt>
              <dd>{provider.rejectedAt ? formatDateTime(provider.rejectedAt) : '-'}</dd>
              <dt>Askı</dt>
              <dd>{provider.suspendedAt ? formatDateTime(provider.suspendedAt) : '-'}</dd>
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
            <h2>Moderasyon</h2>
            <form action={updateProviderStatusAction} style={{ display: 'grid', gap: 12 }}>
              <input type="hidden" name="id" value={provider.id} />
              <label className="form-row">
                <span>Durum</span>
                <select name="status" defaultValue={provider.status}>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-row">
                <span>Moderasyon notu</span>
                <textarea name="moderationNote" defaultValue={provider.moderationNote ?? ''} />
              </label>
              <label className="form-row">
                <span>Ret gerekçesi</span>
                <textarea name="rejectionReason" defaultValue={provider.rejectionReason ?? ''} />
              </label>
              <div>
                <button className="btn btn-primary btn-block" type="submit">Durumu Kaydet</button>
              </div>
            </form>
          </section>

          <div className="notice">
            Hizmet verenin web tarafındaki eşleşen talepler önizlemesi:{' '}
            <a href={`http://localhost:3000/providers/${provider.id}/requests`}>aç</a>
          </div>
        </div>
      </div>
    </main>
  );
}
