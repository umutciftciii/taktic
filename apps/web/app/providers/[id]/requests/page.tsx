import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  Category,
  fetchOrNotFound,
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
import { CategoryVisual } from '../../../category-visual';
import { IconArrowRight } from '../../../landing-icons';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';
import { providerStatusBadgeClass, formatBudgetRange } from '../../provider-ui';
import { DeliveryModeBadge } from '../../../request-fields/delivery-mode-badge';
import { DistrictWideLocationTag } from '../../../request-fields/district-wide-location-tag';

type ProviderRequestsPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    categoryId?: string;
    city?: string;
    district?: string;
    /** QUALITY-SCORE-001: "at least this label" — MEDIUM or HIGH. */
    minQualityLabel?: string;
    /** Retired. Read only to say so; never forwarded and never translated. */
    minQualityScore?: string;
  }>;
};

const MIN_QUALITY_OPTIONS = [
  { value: '', label: 'Tümü' },
  { value: 'MEDIUM', label: 'Orta ve üstü' },
  { value: 'HIGH', label: 'Yalnız yüksek' },
];

export default async function ProviderRequestsPage({ params, searchParams }: ProviderRequestsPageProps) {
  const { id } = await params;
  // A link or bookmark from before the label filter may still carry the
  // numeric minimum. It is not applied — a number on the old scale means
  // something else on the current one — and the page says so instead of
  // quietly picking a label for the provider.
  const { minQualityScore: retiredMinQualityScore, ...filters } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/requests`);
  }

  const [provider, categories, creditBalance] = await Promise.all([
    // Another provider's id in the URL comes back as 403; that belongs on the
    // 404 page rather than in the error boundary.
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    apiFetch<Category[]>('/categories'),
    readCreditBalance(id),
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
    <ProviderShell
      user={user}
      providerId={provider.id}
      businessName={provider.businessName}
      active="requests"
      creditBalance={creditBalance}
      status={provider.status}
      counts={{ requests: requests.length }}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Uygun Talepler</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Eşleşen talepler</span>
        <h1 className="pdash-page-title">Uygun Talepler</h1>
        <p className="pdash-page-sub">
          Hizmet bölgen ve kategorilerinle eşleşen açık talepler. Teklif göndermek kategoriye göre
          kredi düşer; her talebin kredi bedeli aşağıda ve detay ekranında yazılıdır.{' '}
          <span className={providerStatusBadgeClass(provider.status)}>
            {statusLabel(provider.status)}
          </span>
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
          <span>Kalite</span>
          <select name="minQualityLabel" defaultValue={filters.minQualityLabel ?? ''} data-testid="min-quality-label">
            {MIN_QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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

      {retiredMinQualityScore ? (
        <div className="pdash-notice pdash-notice-warn" role="status" data-testid="retired-quality-filter-notice">
          Sayısal kalite filtresi (en az {retiredMinQualityScore}) kaldırıldı ve bu listeye uygulanmadı. Kalite
          etiketine göre daraltmak için yukarıdaki “Kalite” seçimini kullanın.
        </div>
      ) : null}

      {errorMessage ? <div className="pdash-notice pdash-notice-error">{errorMessage}</div> : null}

      <div className="tabstrip-wrap">
        <span className="tabstrip-count">
          <strong data-testid="matching-request-count">{requests.length}</strong> eşleşen talep
        </span>
        {typeof creditBalance === 'number' ? (
          <span className="tabstrip-count">Kredi bakiyesi: {creditBalance}</span>
        ) : null}
      </div>

      {!errorMessage && requests.length === 0 ? (
        <div className="pdash-empty" style={{ marginTop: 24 }}>
          <h3>Şu an uygun talep yok</h3>
          <p>Yeni talepler geldiğinde burada görüntülenecek.</p>
          <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/offers`}>
            Tekliflerimi Gör
          </Link>
        </div>
      ) : null}

      {requests.length > 0 ? (
        <div className="rowlist" style={{ marginTop: 16 }}>
          {requests.map((request) => (
            <article className="datarow" key={request.id}>
              <span className="datarow-media datarow-media-lg">
                <CategoryVisual
                  illustrationKey={request.category.illustrationKey}
                  name={request.category.name}
                  iconSize={28}
                  alt=""
                />
              </span>

              <div className="datarow-body">
                <h3 className="datarow-title">
                  <span>{request.category.name}</span>
                  <span className="tag tag-accent">
                    Kalite {qualityLabel(request.qualityLabel)} · {request.qualityScore}
                  </span>
                  {request.urgency ? (
                    <span className={urgencyTagClass(request.urgency)}>
                      {urgencyLabel(request.urgency)}
                    </span>
                  ) : null}
                </h3>
                <p className="datarow-meta">
                  <DeliveryModeBadge request={request} />
                  <span>
                    {request.city}/{request.district}
                    {request.neighborhood ? `/${request.neighborhood}` : ''}
                  </span>
                  <DistrictWideLocationTag request={request} />
                  <span>{formatDateTime(request.submittedAt)}</span>
                  <span>{request.answersCount} yanıt</span>
                </p>
              </div>

              <div className="datarow-stat">
                <span className="datarow-stat-label">Bütçe</span>
                <span className="datarow-stat-value" style={{ fontSize: 14 }}>
                  {formatBudgetRange(request.budgetMin, request.budgetMax, (n) => formatPrice(n))}
                </span>
              </div>

              <div className="datarow-stat">
                <span className="datarow-stat-label">Teklif kredisi</span>
                {request.canOffer && request.offerCreditCost !== null ? (
                  <span className="datarow-stat-value" data-testid="request-offer-credit-cost">
                    {request.offerCreditCost}
                  </span>
                ) : (
                  <span
                    className="tag tag-neutral"
                    title={offerBlockedTitle(request.offerBlockedReason)}
                  >
                    Teklif verilemez
                  </span>
                )}
              </div>

              <div className="datarow-actions">
                <Link
                  className="pdash-btn pdash-btn-primary pdash-btn-sm"
                  href={`/providers/${id}/requests/${request.id}`}
                >
                  Detay ve Teklif
                  <IconArrowRight size={12} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </ProviderShell>
  );
}

/** An urgent request is the one state the list fills with ink. */
function urgencyTagClass(urgency: string): string {
  return urgency === 'ASAP' || urgency === 'TODAY' ? 'tag tag-ink' : 'tag tag-neutral';
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
