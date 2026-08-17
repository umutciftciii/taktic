import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  Category,
  getCurrentUser,
  OfferBlockedReason,
  ProviderProfile,
  ProviderRequestListItem,
  formatPrice,
  formatDateTime,
  qualityLabel,
  statusLabel,
  urgencyLabel,
} from '../../../../lib/api';
import { ProviderShell } from '../../provider-shell';
import {
  providerQualityBadgeClass,
  providerStatusBadgeClass,
  formatBudgetRange,
} from '../../provider-ui';

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
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/requests`);
  }

  const [provider, categories] = await Promise.all([
    apiFetch<ProviderProfile>(`/providers/${id}`),
    apiFetch<Category[]>('/categories'),
  ]);

  let requests: ProviderRequestListItem[] = [];
  let errorMessage: string | null = null;

  try {
    requests = await apiFetch<ProviderRequestListItem[]>(
      `/providers/${id}/requests${toQueryString(filters)}`,
    );
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Talepler yüklenemedi';
  }

  return (
    <ProviderShell user={user} providerId={provider.id} businessName={provider.businessName} active="requests">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Uygun Talepler</span>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">Uygun Talepler</h1>
        <p className="pdash-page-sub">
          Hizmet bölgeniz ve kategorilerinize uyan açık taleplerin listesi.{' '}
          <span className={providerStatusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
        </p>
      </header>

      <form className="pdash-filters" aria-label="Talep filtreleri">
        <label className="pdash-filter-field">
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
        <label className="pdash-filter-field">
          <span>İl</span>
          <input name="city" defaultValue={filters.city ?? ''} placeholder="Örn. İstanbul" />
        </label>
        <label className="pdash-filter-field">
          <span>İlçe</span>
          <input name="district" defaultValue={filters.district ?? ''} placeholder="Örn. Kadıköy" />
        </label>
        <label className="pdash-filter-field">
          <span>Min. kalite</span>
          <input
            name="minQualityScore"
            type="number"
            min="0"
            max="100"
            defaultValue={filters.minQualityScore ?? ''}
            placeholder="0-100"
          />
        </label>
        <div className="pdash-filter-actions">
          <Link className="pdash-btn pdash-btn-secondary pdash-btn-sm" href={`/providers/${id}/requests`}>
            Temizle
          </Link>
          <button className="pdash-btn pdash-btn-primary pdash-btn-sm" type="submit">
            Filtrele
          </button>
        </div>
      </form>

      {errorMessage ? <div className="pdash-notice pdash-notice-error">{errorMessage}</div> : null}

      <div className="pdash-section-head">
        <h2 className="pdash-section-title">
          Eşleşen Talepler
          <span className="pdash-section-count">{requests.length}</span>
        </h2>
      </div>

      {!errorMessage && requests.length === 0 ? (
        <div className="pdash-empty">
          <h3>Şu an uygun talep yok</h3>
          <p>Yeni talepler geldiğinde burada görüntülenecek.</p>
          <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/offers`}>
            Tekliflerimi Gör
          </Link>
        </div>
      ) : null}

      {requests.length > 0 ? (
        <div className="pdash-grid">
          {requests.map((request) => (
            <article className="pdash-card" key={request.id}>
              <div className="pdash-card-head">
                <div style={{ minWidth: 0 }}>
                  <h3 className="pdash-card-title">{request.category.name}</h3>
                  <p className="pdash-card-sub">
                    {request.city}/{request.district}
                    {request.neighborhood ? `/${request.neighborhood}` : ''}
                  </p>
                </div>
                <span className={providerQualityBadgeClass(request.qualityLabel)}>
                  {qualityLabel(request.qualityLabel)} · {request.qualityScore}/100
                </span>
              </div>

              <div className="pdash-card-meta">
                <span>📅 {formatDateTime(request.submittedAt)}</span>
                <span>💰 Bütçe: {formatBudgetRange(request.budgetMin, request.budgetMax, (n) => formatPrice(n))}</span>
                <span>⏱ Aciliyet: {urgencyLabel(request.urgency)}</span>
                <span>💬 {request.answersCount} yanıt</span>
              </div>

              <div className="pdash-card-foot">
                {request.canOffer ? (
                  <span className="pdash-badge pdash-badge-info">
                    Teklif: {request.offerCreditCost} kredi
                  </span>
                ) : (
                  <span
                    className="pdash-badge pdash-badge-warn"
                    title={offerBlockedTitle(request.offerBlockedReason)}
                  >
                    Teklif verilemez
                  </span>
                )}
                <Link
                  className="pdash-btn pdash-btn-primary pdash-btn-sm"
                  href={`/providers/${id}/requests/${request.id}`}
                >
                  Detay ve Teklif
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </ProviderShell>
  );
}

function offerBlockedTitle(reason: OfferBlockedReason | null) {
  if (reason === 'CATEGORY_INACTIVE') {
    return 'Bu kategori pasif durumda; yeni teklif verilemez.';
  }

  if (reason === 'CATEGORY_PRICE_UNSET') {
    return 'Bu kategori için teklif kredisi tanımlı değil.';
  }

  return 'Bu talebe şu anda teklif verilemiyor.';
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
