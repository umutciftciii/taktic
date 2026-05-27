import Link from 'next/link';
import { apiFetch, ProviderProfile, statusLabel, statusBadgeClass, formatDateTime } from '../../lib/api';

export default async function AdminProvidersPage() {
  const providers = await apiFetch<ProviderProfile[]>('/providers');

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Hizmet Verenler</h1>
        <p className="page-subtitle">Başvurular, aktif ve askıdaki hizmet verenler.</p>
      </header>

      <div className="table-card">
        <div className="table-header">
          <h2>Hizmet veren listesi</h2>
          <span className="muted" style={{ fontSize: 13 }}>{providers.length} kayıt</span>
        </div>
        {providers.length === 0 ? (
          <div style={{ padding: 18 }} className="empty-state">Henüz hizmet veren yok.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Oluşturulma</th>
                  <th>İşletme</th>
                  <th>Yetkili</th>
                  <th>Telefon</th>
                  <th>Konum</th>
                  <th>Kategoriler</th>
                  <th>Durum</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => (
                  <tr key={provider.id}>
                    <td>{formatDateTime(provider.createdAt)}</td>
                    <td><strong>{provider.businessName}</strong></td>
                    <td>{provider.contactName}</td>
                    <td>{provider.phone}</td>
                    <td>{provider.city}/{provider.district}</td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {provider.serviceCategories.map((item) => item.category.name).join(', ') || '-'}
                    </td>
                    <td>
                      <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
                    </td>
                    <td>
                      <div className="inline-actions">
                        <Link className="btn btn-secondary btn-sm" href={`/providers/${provider.id}`}>
                          Detay
                        </Link>
                        <Link className="btn btn-ghost btn-sm" href={`/offers?providerId=${provider.id}`}>
                          Teklifler
                        </Link>
                        <Link className="btn btn-ghost btn-sm" href={`/providers/${provider.id}/credits`}>
                          Krediler
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
