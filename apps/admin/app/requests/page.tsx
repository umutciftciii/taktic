import Link from 'next/link';
import {
  apiFetch,
  Category,
  QualityLabel,
  ServiceRequest,
  ServiceRequestStatus,
  formatBudgetRange,
  formatDateTime,
  qualityBadgeClass,
  qualityLabel,
  requestStatusLabel,
  statusBadgeClass,
} from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { EmptyState } from '../../components/empty-state';

type RawSearchParams = {
  q?: string;
  status?: string;
  quality?: string;
  category?: string;
  city?: string;
  from?: string;
  to?: string;
};

type AdminRequestsPageProps = {
  searchParams: Promise<RawSearchParams>;
};

type StatusFilter = ServiceRequestStatus | 'all';
type QualityFilter = QualityLabel | 'all';

const statusFilters: Array<{ label: string; value: StatusFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Taslak', value: 'DRAFT' },
  { label: 'Yeni Talep', value: 'SUBMITTED' },
  { label: 'İncelemede', value: 'IN_REVIEW' },
  { label: 'Onaylandı', value: 'APPROVED' },
  { label: 'Reddedildi', value: 'REJECTED' },
  { label: 'İptal Edildi', value: 'CANCELLED' },
];

const qualityFilters: Array<{ label: string; value: QualityFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Yüksek', value: 'HIGH' },
  { label: 'Orta', value: 'MEDIUM' },
  { label: 'Düşük', value: 'LOW' },
];

function normalizeStatus(value: string | undefined): StatusFilter {
  const upper = value?.toUpperCase();
  if (
    upper === 'DRAFT' ||
    upper === 'SUBMITTED' ||
    upper === 'IN_REVIEW' ||
    upper === 'APPROVED' ||
    upper === 'REJECTED' ||
    upper === 'CANCELLED'
  ) {
    return upper;
  }
  return 'all';
}

function normalizeQuality(value: string | undefined): QualityFilter {
  const upper = value?.toUpperCase();
  if (upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW') return upper;
  return 'all';
}

function toLower(value: string | null | undefined) {
  return (value ?? '').toLocaleLowerCase('tr-TR');
}

function parseDateBoundary(value: string | undefined, edge: 'start' | 'end'): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  if (edge === 'end') {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return date;
}

export default async function AdminRequestsPage({ searchParams }: AdminRequestsPageProps) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const status = normalizeStatus(params.status);
  const quality = normalizeQuality(params.quality);
  const categorySlug = (params.category ?? '').trim();
  const cityFilter = (params.city ?? '').trim();
  const fromDate = parseDateBoundary(params.from, 'start');
  const toDate = parseDateBoundary(params.to, 'end');

  const [requests, categories] = await Promise.all([
    apiFetch<ServiceRequest[]>('/service-requests'),
    apiFetch<Category[]>('/categories?includeInactive=true').catch(() => [] as Category[]),
  ]);

  const normalizedQuery = toLower(query);
  const normalizedCity = toLower(cityFilter);

  const filtered = requests.filter((request) => {
    if (status !== 'all' && request.status !== status) return false;
    if (quality !== 'all' && request.qualityLabel !== quality) return false;
    if (categorySlug && request.category.slug !== categorySlug) return false;
    if (normalizedCity && !toLower(request.city).includes(normalizedCity)) return false;

    if (fromDate || toDate) {
      const submitted = new Date(request.submittedAt);
      if (Number.isNaN(submitted.getTime())) return false;
      if (fromDate && submitted < fromDate) return false;
      if (toDate && submitted > toDate) return false;
    }

    if (normalizedQuery) {
      const haystack = [
        request.customerName,
        request.customerPhone,
        request.customerEmail,
        request.category.name,
        request.city,
        request.district,
      ]
        .map(toLower)
        .join(' ');
      if (!haystack.includes(normalizedQuery)) return false;
    }

    return true;
  });

  const sortedCategories = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, 'tr-TR'),
  );

  const hasFilters =
    query.length > 0 ||
    status !== 'all' ||
    quality !== 'all' ||
    categorySlug.length > 0 ||
    cityFilter.length > 0 ||
    Boolean(params.from?.trim()) ||
    Boolean(params.to?.trim());

  return (
    <main className="requests-page">
      <PageHeader
        title="Talepler"
        subtitle="Müşteri taleplerini inceleyin, kalite ve moderasyon durumlarını yönetin."
      />

      <form className="admin-toolbar request-toolbar" method="get" action="/requests">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="request-search">Ara</label>
          <input
            id="request-search"
            name="q"
            type="search"
            placeholder="Müşteri, telefon, kategori, şehir"
            defaultValue={query}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="request-status">Durum</label>
          <select id="request-status" name="status" defaultValue={status}>
            {statusFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="request-quality">Kalite</label>
          <select id="request-quality" name="quality" defaultValue={quality}>
            {qualityFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="request-category">Kategori</label>
          <select id="request-category" name="category" defaultValue={categorySlug}>
            <option value="">Tümü</option>
            {sortedCategories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="request-city">Şehir</label>
          <input
            id="request-city"
            name="city"
            type="text"
            placeholder="İstanbul"
            defaultValue={cityFilter}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="request-from">Başlangıç</label>
          <input
            id="request-from"
            name="from"
            type="date"
            defaultValue={params.from ?? ''}
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="request-to">Bitiş</label>
          <input
            id="request-to"
            name="to"
            type="date"
            defaultValue={params.to ?? ''}
          />
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {filtered.length} / {requests.length} kayıt
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/requests">
              Sıfırla
            </Link>
          ) : null}
        </div>
      </form>

      <div className="table-card request-list-card">
        <div className="table-header">
          <div className="table-header-text">
            <h2>Talep listesi</h2>
            <p className="table-header-sub">
              Filtreler URL üzerinden paylaşılabilir.
            </p>
          </div>
          <span className="admin-toolbar-summary">{filtered.length} kayıt</span>
        </div>
        {filtered.length === 0 ? (
          <div style={{ padding: 18 }}>
            {requests.length === 0 ? (
              <EmptyState
                title="Henüz talep yok."
                description="Müşteri talepleri geldikçe burada listelenecek."
              />
            ) : (
              <EmptyState
                title="Filtrelere uygun talep bulunamadı."
                description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
                action={
                  <Link className="btn btn-secondary btn-sm" href="/requests">
                    Filtreleri temizle
                  </Link>
                }
              />
            )}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Talep No</th>
                  <th>Gönderim</th>
                  <th>Kategori</th>
                  <th>Müşteri</th>
                  <th>Konum</th>
                  <th>Bütçe</th>
                  <th>Kalite</th>
                  <th>Durum</th>
                  <th className="col-num">Teklif</th>
                  <th className="col-actions">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((request) => {
                  const offerCount =
                    typeof request.offersCount === 'number'
                      ? request.offersCount
                      : typeof request._count?.offers === 'number'
                        ? request._count.offers
                        : null;
                  const secondaryLocation = request.neighborhood || request.addressNote;
                  const requestRef = request.requestNumber ?? `#${request.id.slice(-8)}`;
                  return (
                    <tr key={request.id}>
                      <td>
                        <code className="display-number">{requestRef}</code>
                      </td>
                      <td>{formatDateTime(request.submittedAt)}</td>
                      <td>
                        <div className="cell-stack">
                          <span>{request.category.name}</span>
                          {request.category.slug ? (
                            <span className="cell-muted">{request.category.slug}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <strong>{request.customerName}</strong>
                          {request.customerPhone ? (
                            <a className="cell-link" href={`tel:${request.customerPhone}`}>
                              {request.customerPhone}
                            </a>
                          ) : null}
                          {request.customerEmail ? (
                            <a className="cell-link cell-muted" href={`mailto:${request.customerEmail}`}>
                              {request.customerEmail}
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span>
                            {request.city}/{request.district}
                          </span>
                          {secondaryLocation ? (
                            <span className="cell-muted">{secondaryLocation}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>{formatBudgetRange(request.budgetMin, request.budgetMax)}</td>
                      <td>
                        <div className="quality-cell">
                          <span className={qualityBadgeClass(request.qualityLabel)}>
                            {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
                          </span>
                          <div
                            className="request-quality-bar request-quality-bar-sm"
                            role="presentation"
                          >
                            <span
                              className={`request-quality-bar-fill request-quality-bar-fill-${request.qualityLabel.toLowerCase()}`}
                              style={{ width: `${Math.min(100, Math.max(0, request.qualityScore))}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={statusBadgeClass(request.status)}>
                          {requestStatusLabel(request.status)}
                        </span>
                      </td>
                      <td className="col-num">
                        {offerCount === null ? (
                          <span className="cell-muted">—</span>
                        ) : offerCount === 0 ? (
                          <span className="cell-muted">0</span>
                        ) : (
                          <span className="badge badge-good">{offerCount}</span>
                        )}
                      </td>
                      <td className="col-actions">
                        <div className="inline-actions">
                          <Link className="btn btn-secondary btn-sm" href={`/requests/${request.id}`}>
                            Detay
                          </Link>
                          <Link
                            className="btn btn-ghost btn-sm"
                            href={`/offers?requestId=${request.id}`}
                          >
                            Teklifler
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
