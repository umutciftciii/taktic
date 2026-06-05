import Link from 'next/link';
import {
  apiFetch,
  Category,
  Offer,
  OfferStatus,
  RefundRecommendedAction,
  statusLabel,
  statusBadgeClass,
  refundActionLabel,
  refundActionBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { EmptyState } from '../../components/empty-state';
import { StatCard } from '../../components/stat-card';

type RawSearchParams = {
  q?: string;
  status?: string;
  providerId?: string;
  requestId?: string;
  category?: string;
  city?: string;
  from?: string;
  to?: string;
  refundAction?: string;
};

type AdminOffersPageProps = {
  searchParams?: Promise<RawSearchParams>;
};

type StatusFilter = OfferStatus | 'all';
type RefundActionFilter = RefundRecommendedAction | 'all';

const statusFilters: Array<{ label: string; value: StatusFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Gönderildi', value: 'SUBMITTED' },
  { label: 'Görüntülendi', value: 'VIEWED' },
  { label: 'Kısa listede', value: 'SHORTLISTED' },
  { label: 'Kabul edildi', value: 'ACCEPTED' },
  { label: 'Reddedildi', value: 'REJECTED' },
  { label: 'Geri çekildi', value: 'WITHDRAWN' },
  { label: 'Süresi doldu', value: 'EXPIRED' },
  { label: 'İptal', value: 'CANCELLED' },
];

const refundFilters: Array<{ label: string; value: RefundActionFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Tam iade önerilir', value: 'FULL_REFUND' },
  { label: 'Manuel inceleme', value: 'MANUAL_REVIEW' },
  { label: 'İade yok', value: 'NO_REFUND' },
];

function normalizeStatus(value: string | undefined): StatusFilter {
  const upper = value?.toUpperCase();
  if (
    upper === 'SUBMITTED' ||
    upper === 'VIEWED' ||
    upper === 'SHORTLISTED' ||
    upper === 'ACCEPTED' ||
    upper === 'REJECTED' ||
    upper === 'WITHDRAWN' ||
    upper === 'EXPIRED' ||
    upper === 'CANCELLED'
  ) {
    return upper;
  }
  return 'all';
}

function normalizeRefundAction(value: string | undefined): RefundActionFilter {
  const upper = value?.toUpperCase();
  if (upper === 'FULL_REFUND' || upper === 'MANUAL_REVIEW' || upper === 'NO_REFUND') {
    return upper;
  }
  return 'all';
}

function isIsoDate(value: string) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

export default async function AdminOffersPage({ searchParams }: AdminOffersPageProps) {
  const params = (await searchParams) ?? {};
  const query = (params.q ?? '').trim();
  const status = normalizeStatus(params.status);
  const refundAction = normalizeRefundAction(params.refundAction);
  const categorySlug = (params.category ?? '').trim();
  const cityFilter = (params.city ?? '').trim();
  const fromValue = (params.from ?? '').trim();
  const toValue = (params.to ?? '').trim();
  const providerId = (params.providerId ?? '').trim();
  const requestId = (params.requestId ?? '').trim();

  const apiQuery = new URLSearchParams();
  if (query) apiQuery.set('q', query);
  if (status !== 'all') apiQuery.set('status', status);
  if (providerId) apiQuery.set('providerId', providerId);
  if (requestId) apiQuery.set('requestId', requestId);
  if (categorySlug) apiQuery.set('categorySlug', categorySlug);
  if (cityFilter) apiQuery.set('city', cityFilter);
  if (fromValue && isIsoDate(fromValue)) {
    apiQuery.set('submittedFrom', new Date(fromValue).toISOString());
  }
  if (toValue && isIsoDate(toValue)) {
    const toDate = new Date(toValue);
    toDate.setHours(23, 59, 59, 999);
    apiQuery.set('submittedTo', toDate.toISOString());
  }

  const offersPath = apiQuery.toString() ? `/offers?${apiQuery.toString()}` : '/offers';

  const [offers, categories] = await Promise.all([
    apiFetch<Offer[]>(offersPath),
    apiFetch<Category[]>('/categories?includeInactive=true').catch(() => [] as Category[]),
  ]);

  const filtered =
    refundAction === 'all'
      ? offers
      : offers.filter((offer) => offer.refundEligibility.recommendedAction === refundAction);

  const sortedCategories = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, 'tr-TR'),
  );

  const fullRefundCount = offers.filter(
    (o) => o.refundEligibility.recommendedAction === 'FULL_REFUND',
  ).length;
  const manualReviewCount = offers.filter(
    (o) => o.refundEligibility.recommendedAction === 'MANUAL_REVIEW',
  ).length;
  const newUnviewedCount = offers.filter(
    (o) => o.status === 'SUBMITTED' && !o.viewedAt,
  ).length;

  const pinnedProvider = providerId ? offers.find((o) => o.provider.id === providerId) : null;
  const pinnedRequest = requestId ? offers.find((o) => o.request.id === requestId) : null;

  const hasPinned = Boolean(providerId || requestId);
  const hasFilters =
    query.length > 0 ||
    status !== 'all' ||
    refundAction !== 'all' ||
    categorySlug.length > 0 ||
    cityFilter.length > 0 ||
    fromValue.length > 0 ||
    toValue.length > 0;

  const buildClearLink = (drop: 'providerId' | 'requestId' | 'all') => {
    if (drop === 'all') {
      return '/offers';
    }
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (status !== 'all') next.set('status', status);
    if (refundAction !== 'all') next.set('refundAction', refundAction);
    if (categorySlug) next.set('category', categorySlug);
    if (cityFilter) next.set('city', cityFilter);
    if (fromValue) next.set('from', fromValue);
    if (toValue) next.set('to', toValue);
    if (drop !== 'providerId' && providerId) next.set('providerId', providerId);
    if (drop !== 'requestId' && requestId) next.set('requestId', requestId);
    const qs = next.toString();
    return qs ? `/offers?${qs}` : '/offers';
  };

  return (
    <main>
      <PageHeader
        title="Teklifler"
        subtitle="Hizmet verenler tarafından gönderilen tüm teklifleri inceleyin, iade adaylarını yönetin."
      />

      <section className="stat-grid">
        <StatCard label="Toplam teklif" value={offers.length} />
        <StatCard
          label="İade adayı"
          value={fullRefundCount}
          tone={fullRefundCount > 0 ? 'success' : 'neutral'}
        />
        <StatCard
          label="Manuel inceleme"
          value={manualReviewCount}
          tone={manualReviewCount > 0 ? 'warning' : 'neutral'}
        />
        <StatCard label="Yeni / görüntülenmemiş" value={newUnviewedCount} />
      </section>

      {hasPinned ? (
        <div className="admin-filter-pins" style={{ marginBottom: 14 }}>
          {pinnedProvider ? (
            <span className="badge badge-muted">
              HV: {pinnedProvider.provider.businessName}{' '}
              <Link className="cell-link" href={buildClearLink('providerId')}>
                ×
              </Link>
            </span>
          ) : providerId ? (
            <span className="badge badge-muted">
              HV: <code style={{ fontSize: 11 }}>{providerId}</code>{' '}
              <Link className="cell-link" href={buildClearLink('providerId')}>
                ×
              </Link>
            </span>
          ) : null}
          {pinnedRequest ? (
            <span className="badge badge-muted">
              Talep: {pinnedRequest.request.category.name} · {pinnedRequest.request.city}/
              {pinnedRequest.request.district}{' '}
              <Link className="cell-link" href={buildClearLink('requestId')}>
                ×
              </Link>
            </span>
          ) : requestId ? (
            <span className="badge badge-muted">
              Talep: <code style={{ fontSize: 11 }}>{requestId}</code>{' '}
              <Link className="cell-link" href={buildClearLink('requestId')}>
                ×
              </Link>
            </span>
          ) : null}
        </div>
      ) : null}

      <form className="admin-toolbar" method="get" action="/offers">
        {providerId ? <input type="hidden" name="providerId" value={providerId} /> : null}
        {requestId ? <input type="hidden" name="requestId" value={requestId} /> : null}
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="offer-q">Ara</label>
          <input
            id="offer-q"
            name="q"
            type="search"
            placeholder="HV, müşteri, şehir, ID"
            defaultValue={query}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="offer-status">Durum</label>
          <select id="offer-status" name="status" defaultValue={status}>
            {statusFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="offer-refund">İade önerisi</label>
          <select id="offer-refund" name="refundAction" defaultValue={refundAction}>
            {refundFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="offer-category">Kategori</label>
          <select id="offer-category" name="category" defaultValue={categorySlug}>
            <option value="">Tümü</option>
            {sortedCategories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="offer-city">Şehir</label>
          <input
            id="offer-city"
            name="city"
            type="text"
            placeholder="İstanbul"
            defaultValue={cityFilter}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="offer-from">Başlangıç</label>
          <input id="offer-from" name="from" type="date" defaultValue={fromValue} />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="offer-to">Bitiş</label>
          <input id="offer-to" name="to" type="date" defaultValue={toValue} />
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {filtered.length} / {offers.length} kayıt
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters || hasPinned ? (
            <Link className="btn btn-ghost btn-sm" href={buildClearLink('all')}>
              Sıfırla
            </Link>
          ) : null}
        </div>
      </form>

      <div className="table-card">
        <div className="table-header">
          <div className="table-header-text">
            <h2>Teklif listesi</h2>
            <p className="table-header-sub">Filtreler URL üzerinden paylaşılabilir.</p>
          </div>
          <span className="admin-toolbar-summary">{filtered.length} kayıt</span>
        </div>
        {filtered.length === 0 ? (
          <div style={{ padding: 18 }}>
            {offers.length === 0 && !hasFilters && !hasPinned ? (
              <EmptyState
                title="Henüz teklif yok."
                description="Hizmet verenler talep oluşturduğunuzda buradan listeleyebileceksiniz."
              />
            ) : (
              <EmptyState
                title="Filtrelere uygun teklif bulunamadı."
                description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
                action={
                  <Link className="btn btn-secondary btn-sm" href={buildClearLink('all')}>
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
                  <th>Teklif No</th>
                  <th>Talep No</th>
                  <th>Gönderim</th>
                  <th>Hizmet Veren</th>
                  <th>Kategori</th>
                  <th>Müşteri</th>
                  <th>Konum</th>
                  <th className="col-num">Fiyat</th>
                  <th className="col-num">Kredi</th>
                  <th>Durum</th>
                  <th>İade sinyali</th>
                  <th className="col-actions">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((offer) => {
                  const refundRecommended =
                    offer.refundEligibility.recommendedAction === 'FULL_REFUND' ||
                    offer.refundEligibility.recommendedAction === 'MANUAL_REVIEW';
                  const customerName = offer.request.customerName;
                  const customerPhone = offer.request.customerPhone;
                  const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
                  const requestRef =
                    offer.request.requestNumber ?? `#${offer.request.id.slice(-8)}`;
                  return (
                    <tr key={offer.id}>
                      <td>
                        <code className="display-number">{offerRef}</code>
                      </td>
                      <td>
                        <Link className="cell-link" href={`/requests/${offer.request.id}`}>
                          <code className="display-number">{requestRef}</code>
                        </Link>
                      </td>
                      <td>{formatDateTime(offer.submittedAt)}</td>
                      <td>
                        <div className="cell-stack">
                          <strong>{offer.provider.businessName}</strong>
                          <span className="cell-muted">{offer.provider.contactName}</span>
                        </div>
                      </td>
                      <td>{offer.request.category.name}</td>
                      <td>
                        <div className="cell-stack">
                          <span>{customerName || '-'}</span>
                          {customerPhone ? (
                            <a className="cell-link cell-muted" href={`tel:${customerPhone}`}>
                              {customerPhone}
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        {offer.request.city}/{offer.request.district}
                      </td>
                      <td className="col-num">
                        <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
                      </td>
                      <td className="col-num">{offer.creditCost}</td>
                      <td>
                        <span className={statusBadgeClass(offer.status)}>
                          {statusLabel(offer.status)}
                        </span>
                      </td>
                      <td>
                        {refundRecommended ? (
                          <span
                            className={refundActionBadgeClass(
                              offer.refundEligibility.recommendedAction,
                            )}
                          >
                            {refundActionLabel(offer.refundEligibility.recommendedAction)}
                          </span>
                        ) : offer.creditRefundedAt ? (
                          <span className="badge badge-muted">İade edildi</span>
                        ) : (
                          <span className="cell-muted">-</span>
                        )}
                      </td>
                      <td className="col-actions">
                        <div className="inline-actions">
                          <Link className="btn btn-secondary btn-sm" href={`/offers/${offer.id}`}>
                            Detay
                          </Link>
                          <Link
                            className="btn btn-ghost btn-sm"
                            href={`/requests/${offer.request.id}`}
                          >
                            Talep
                          </Link>
                          <Link
                            className="btn btn-ghost btn-sm"
                            href={`/providers/${offer.provider.id}`}
                          >
                            HV
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
