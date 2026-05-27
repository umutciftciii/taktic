import Link from 'next/link';
import {
  apiFetch,
  QualityLabel,
  ServiceRequest,
  statusLabel,
  statusBadgeClass,
  qualityLabel,
  qualityBadgeClass,
  formatDateTime,
} from '../../lib/api';

type AdminRequestsPageProps = {
  searchParams: Promise<{ quality?: string }>;
};

const qualityFilters: Array<{ label: string; value: QualityLabel | 'all' }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Yüksek', value: 'HIGH' },
  { label: 'Orta', value: 'MEDIUM' },
  { label: 'Düşük', value: 'LOW' },
];

export default async function AdminRequestsPage({ searchParams }: AdminRequestsPageProps) {
  const { quality } = await searchParams;
  const activeQuality = normalizeQualityFilter(quality);
  const requests = await apiFetch<ServiceRequest[]>('/service-requests');
  const filteredRequests =
    activeQuality === 'all'
      ? requests
      : requests.filter((request) => request.qualityLabel === activeQuality);

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Talepler</h1>
        <p className="page-subtitle">Tüm talepleri inceleyin, kaliteye göre filtreleyin.</p>
      </header>

      <div className="filters-card">
        <h2 style={{ margin: 0, fontSize: 15 }}>Kalite filtresi</h2>
        <div className="inline-actions">
          {qualityFilters.map((filter) => {
            const isActive = activeQuality === filter.value;
            const href =
              filter.value === 'all' ? '/requests' : `/requests?quality=${filter.value.toLowerCase()}`;
            return (
              <Link
                key={filter.value}
                href={href}
                className={isActive ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="table-card" style={{ marginTop: 18 }}>
        <div className="table-header">
          <h2>Talep listesi</h2>
          <span className="muted" style={{ fontSize: 13 }}>{filteredRequests.length} kayıt</span>
        </div>
        {filteredRequests.length === 0 ? (
          <div style={{ padding: 18 }} className="empty-state">Sonuç bulunamadı.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Gönderim</th>
                  <th>Kategori</th>
                  <th>Müşteri</th>
                  <th>Telefon</th>
                  <th>Konum</th>
                  <th>Durum</th>
                  <th>Kalite</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.map((request) => (
                  <tr key={request.id}>
                    <td>{formatDateTime(request.submittedAt)}</td>
                    <td>{request.category.name}</td>
                    <td>{request.customerName}</td>
                    <td>{request.customerPhone}</td>
                    <td>{request.city}/{request.district}</td>
                    <td>
                      <span className={statusBadgeClass(request.status)}>{statusLabel(request.status)}</span>
                    </td>
                    <td>
                      <span className={qualityBadgeClass(request.qualityLabel)}>
                        {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
                      </span>
                    </td>
                    <td>
                      <div className="inline-actions">
                        <Link className="btn btn-secondary btn-sm" href={`/requests/${request.id}`}>Detay</Link>
                        <Link className="btn btn-ghost btn-sm" href={`/offers?requestId=${request.id}`}>
                          Teklifler
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

function normalizeQualityFilter(value: string | undefined): QualityLabel | 'all' {
  const normalized = value?.toUpperCase();

  if (normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH') {
    return normalized;
  }

  return 'all';
}
