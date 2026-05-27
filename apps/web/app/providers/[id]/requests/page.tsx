import Link from 'next/link';
import {
  apiFetch,
  Category,
  ProviderProfile,
  ProviderRequestListItem,
  formatPrice,
  formatDateTime,
  qualityLabel,
  qualityBadgeClass,
  statusLabel,
  statusBadgeClass,
  urgencyLabel,
} from '../../../../lib/api';

type ProviderRequestsPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    categoryId?: string;
    city?: string;
    district?: string;
    minQualityScore?: string;
  }>;
};

export default async function ProviderRequestsPage({ params, searchParams }: ProviderRequestsPageProps) {
  const { id } = await params;
  const filters = await searchParams;
  const [provider, categories] = await Promise.all([
    apiFetch<ProviderProfile>(`/providers/${id}`),
    apiFetch<Category[]>('/categories'),
  ]);

  let requests: ProviderRequestListItem[] = [];
  let errorMessage: string | null = null;

  try {
    requests = await apiFetch<ProviderRequestListItem[]>(`/providers/${id}/requests${toQueryString(filters)}`);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Talepler yüklenemedi';
  }

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}`}>Profil</Link>
        <span aria-hidden="true">/</span>
        <span>Eşleşen Talepler</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">Eşleşen Talepler</h1>
        <p className="page-subtitle">
          Hizmet Veren: <strong>{provider.businessName}</strong>{' '}
          <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
        </p>
      </header>

      <form className="filters-card">
        <h2 style={{ margin: 0, fontSize: 15 }}>Filtrele</h2>
        <div className="filters-grid">
          <label className="form-row">
            <span>Kategori</span>
            <select name="categoryId" defaultValue={filters.categoryId ?? ''}>
              <option value="">Tümü</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-row">
            <span>İl</span>
            <input name="city" defaultValue={filters.city ?? ''} />
          </label>
          <label className="form-row">
            <span>İlçe</span>
            <input name="district" defaultValue={filters.district ?? ''} />
          </label>
          <label className="form-row">
            <span>Min. kalite</span>
            <input
              name="minQualityScore"
              type="number"
              min="0"
              max="100"
              defaultValue={filters.minQualityScore ?? ''}
            />
          </label>
        </div>
        <div className="inline-actions">
          <button className="btn btn-primary btn-sm" type="submit">Filtrele</button>
          <Link className="btn btn-secondary btn-sm" href={`/providers/${id}/requests`}>Temizle</Link>
        </div>
      </form>

      {errorMessage ? <div className="notice-error" style={{ marginTop: 18 }}>{errorMessage}</div> : null}
      {!errorMessage && requests.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 18 }}>
          <h2>Eşleşen talep yok</h2>
          <p className="muted">
            Şu anda hizmet verdiğiniz kategori ve bölgelerle eşleşen onaylı talep bulunmuyor. Filtreleri
            genişletmeyi deneyin.
          </p>
        </div>
      ) : null}

      <div className="list-stack" style={{ marginTop: 18 }}>
        {requests.map((request) => (
          <article className="list-card" key={request.id}>
            <div className="list-card-header">
              <div>
                <h2 className="list-card-title">{request.category.name}</h2>
                <p className="list-card-meta">
                  <span>{request.city}/{request.district}{request.neighborhood ? `/${request.neighborhood}` : ''}</span>
                  <span>Bütçe: {formatBudget(request.budgetMin, request.budgetMax)}</span>
                  <span>Aciliyet: {urgencyLabel(request.urgency)}</span>
                  <span>{request.answersCount} yanıt</span>
                  <span>{formatDateTime(request.submittedAt)}</span>
                </p>
              </div>
              <div className="inline-actions">
                <span className={qualityBadgeClass(request.qualityLabel)}>
                  Kalite {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
                </span>
                <span className="badge badge-info">Teklif: 1 kredi</span>
              </div>
            </div>
            <div className="inline-actions">
              <Link className="btn btn-primary btn-sm" href={`/providers/${id}/requests/${request.id}`}>
                Detay ve teklif ver
              </Link>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

function toQueryString(filters: Record<string, string | undefined>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

function formatBudget(min: number | null, max: number | null) {
  if (min !== null && max !== null) {
    return `${formatPrice(min)} - ${formatPrice(max)}`;
  }
  if (min !== null) return `${formatPrice(min)}+`;
  if (max !== null) return `≤ ${formatPrice(max)}`;
  return '-';
}
