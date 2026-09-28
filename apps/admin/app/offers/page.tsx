import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  formatPrice,
  listCatalogueForFilter,
  Offer,
  OfferStatus,
  refundActionBadgeClass,
  refundActionLabel,
  RefundRecommendedAction,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SummaryStrip } from '../../components/summary-strip';
import { SavedViewTabs, type TabItem } from '../../components/tabs';
import { buildHref, parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount, pageWindow } from '../../lib/pagination';

/**
 * Teklifler (#5), design `offers` (ADMIN-DESIGN-001 Faz 3A).
 *
 * The API filters by everything but the refund signal, which is applied here
 * as before, and returns the whole match (no paging); the table is cut into
 * pages of 50 on this server. The saved views are the status filter's values.
 * Only the open view's total is known without another request, so only it
 * carries a counter — the design's per-view figures would each be a request
 * of their own.
 *
 * The design's month-level subtitle ("ortalama 1.860 ₺ · eşleşme oranı %38")
 * is not drawn: no endpoint computes it. The four figures this screen always
 * had stay, computed from the rows it already holds.
 */

const PATH = '/offers';
const PAGE_SIZE = 50;

/** The design's ⓘ, as written. */
const SCREEN_INFO =
  'Hizmet verenlerin taleplere verdiği fiyat teklifleri. Teklif vermek kredi harcar. Müşteri bir teklifi kabul ettiğinde iki taraf birbirinin iletişim bilgisini görür — buna eşleşme diyoruz.';

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
  page?: string;
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

/** The saved views, in the design's order; the rest stay in the status select. */
const VIEW_STATUSES: OfferStatus[] = ['SUBMITTED', 'ACCEPTED', 'REJECTED', 'EXPIRED'];

const refundFilters: Array<{ label: string; value: RefundActionFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'İade edilecek', value: 'FULL_REFUND' },
  { label: 'İade yok', value: 'NO_REFUND' },
];

const COLUMNS: DataColumn[] = [
  { key: 'no', label: 'Teklif no' },
  { key: 'request', label: 'Talep' },
  { key: 'submittedAt', label: 'Verildiği zaman' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'category', label: 'Kategori' },
  { key: 'customer', label: 'Müşteri' },
  { key: 'location', label: 'Konum' },
  { key: 'price', label: 'Teklif', align: 'end' },
  { key: 'credit', label: 'Harcanan kredi', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'refund', label: 'İade sinyali' },
  { key: 'actions', label: 'İşlemler', srOnly: true },
];

function normalizeStatus(value: string | undefined): StatusFilter {
  const upper = value?.toUpperCase();
  return statusFilters.some((filter) => filter.value === upper) && upper !== 'ALL'
    ? (upper as OfferStatus)
    : 'all';
}

function normalizeRefundAction(value: string | undefined): RefundActionFilter {
  const upper = value?.toUpperCase();
  if (upper === 'FULL_REFUND' || upper === 'NO_REFUND') {
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
  const { can } = await requireAdmin('OFFERS_READ');
  const canReadRequests = can('REQUESTS_READ');
  const canReadProviderDetail = can('PROVIDERS_READ_DETAIL');
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
  const page = parsePage(params.page);

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
    listCatalogueForFilter(),
  ]);

  const filtered =
    refundAction === 'all'
      ? offers
      : offers.filter((offer) => offer.refundEligibility.recommendedAction === refundAction);

  const range = pageWindow({ page, pageSize: PAGE_SIZE, total: filtered.length });
  const pageRows = filtered.slice(range.start > 0 ? range.start - 1 : 0, range.end);

  const sortedCategories = [...categories].sort((a, b) => a.name.localeCompare(b.name, 'tr-TR'));

  const fullRefundCount = offers.filter(
    (o) => o.refundEligibility.recommendedAction === 'FULL_REFUND',
  ).length;
  // Offers the customer opened, which the 48-hour rule settles for good. Kept
  // as a figure an operator can read at a glance; there is no action attached to
  // it, because a viewed offer is never refunded.
  const viewedCount = offers.filter((o) => o.refundEligibility.policyStatus === 'VIEWED').length;
  const newUnviewedCount = offers.filter((o) => o.status === 'SUBMITTED' && !o.viewedAt).length;

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

  const filterParams: QueryParams = {
    q: query,
    status: status === 'all' ? '' : status,
    refundAction: refundAction === 'all' ? '' : refundAction,
    category: categorySlug,
    city: cityFilter,
    from: fromValue,
    to: toValue,
    providerId,
    requestId,
  };
  // The pins are part of the view: a filter keeps them, "Temizle" keeps them,
  // and only their own × drops one.
  const pins: QueryParams = { providerId, requestId };
  const clearHref = hasFilters ? buildHref(PATH, pins) : null;
  const unpinHref = (drop: 'providerId' | 'requestId') => buildHref(PATH, filterParams, { [drop]: '' });

  const views: TabItem[] = [
    { key: '', label: 'Tümü', testId: 'offer-view-all' },
    ...VIEW_STATUSES.map((value) => ({
      key: value,
      label: statusLabel(value),
      testId: `offer-view-${value.toLowerCase()}`,
    })),
  ].map((view) => (view.key === (status === 'all' ? '' : status) ? { ...view, count: filtered.length } : view));

  const summary =
    offers.length === 0
      ? hasFilters || hasPinned
        ? 'Filtreye uyan teklif yok'
        : 'Henüz teklif yok'
      : `${hasFilters || hasPinned ? 'Filtreye uyan ' : ''}${formatCount(filtered.length)} teklif · en yeni önce`;

  return (
    <main className="offers-page">
      <PageHeader title="Teklifler" subtitle={summary} info={SCREEN_INFO} />

      <SummaryStrip
        label="Teklif özeti"
        items={[
          { label: 'Toplam teklif', value: formatCount(offers.length), testId: 'offer-stat-total' },
          {
            label: 'İade adayı',
            value: formatCount(fullRefundCount),
            tone: fullRefundCount > 0 ? 'success' : 'neutral',
            testId: 'offer-stat-refund',
          },
          { label: 'Görüntülendi', value: formatCount(viewedCount), note: 'Otomatik iade kapsamı dışında' },
          { label: 'Yeni / görüntülenmemiş', value: formatCount(newUnviewedCount) },
        ]}
      />

      {hasPinned ? (
        <div className="admin-filter-pins" data-testid="offer-pins">
          {providerId ? (
            <span className="badge badge-muted">
              HV:{' '}
              {pinnedProvider ? (
                pinnedProvider.provider.businessName
              ) : (
                <code className="cell-break">{providerId}</code>
              )}{' '}
              <Link
                className="cell-link"
                href={unpinHref('providerId')}
                aria-label="Hizmet veren sabitlemesini kaldır"
              >
                ×
              </Link>
            </span>
          ) : null}
          {requestId ? (
            <span className="badge badge-muted">
              Talep:{' '}
              {pinnedRequest ? (
                <>
                  {pinnedRequest.request.category.name} · {pinnedRequest.request.city}/
                  {pinnedRequest.request.district}
                </>
              ) : (
                <code className="cell-break">{requestId}</code>
              )}{' '}
              <Link className="cell-link" href={unpinHref('requestId')} aria-label="Talep sabitlemesini kaldır">
                ×
              </Link>
            </span>
          ) : null}
        </div>
      ) : null}

      <SavedViewTabs
        label="Teklif görünümleri"
        items={views}
        active={status === 'all' ? '' : status}
        path={PATH}
        params={filterParams}
        param="status"
        testId="offer-views"
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={clearHref}
        preserve={pins}
        label="Teklif filtreleri"
        testId="offer-filters"
      >
        <FilterField label="Ara" htmlFor="offer-q" wide>
          <input
            id="offer-q"
            name="q"
            type="search"
            placeholder="HV, müşteri, şehir, ID"
            defaultValue={query}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Durum" htmlFor="offer-status">
          <select id="offer-status" name="status" defaultValue={status}>
            {statusFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="İade önerisi" htmlFor="offer-refund">
          <select id="offer-refund" name="refundAction" defaultValue={refundAction}>
            {refundFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Kategori" htmlFor="offer-category">
          <select id="offer-category" name="category" defaultValue={categorySlug}>
            <option value="">Tümü</option>
            {sortedCategories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Şehir" htmlFor="offer-city">
          <input
            id="offer-city"
            name="city"
            type="text"
            placeholder="İstanbul"
            defaultValue={cityFilter}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Başlangıç" htmlFor="offer-from">
          <input id="offer-from" name="from" type="date" defaultValue={fromValue} />
        </FilterField>
        <FilterField label="Bitiş" htmlFor="offer-to">
          <input id="offer-to" name="to" type="date" defaultValue={toValue} />
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {filtered.length === 0 ? (
          offers.length === 0 && !hasFilters && !hasPinned ? (
            <EmptyState
              title="Henüz teklif yok."
              description="Hizmet verenler onaylı taleplere teklif verdikçe burada listelenecek."
            />
          ) : (
            <EmptyState
              title="Filtrelere uygun teklif bulunamadı."
              description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
              action={
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Filtreleri temizle
                </Link>
              }
            />
          )
        ) : (
          <DataTable caption="Teklifler" columns={COLUMNS} minWidth={1280} testId="offer-table">
            {pageRows.map((offer) => (
              <OfferRow
                key={offer.id}
                offer={offer}
                canReadRequests={canReadRequests}
                canReadProviderDetail={canReadProviderDetail}
              />
            ))}
          </DataTable>
        )}
        {filtered.length > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={range.page}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            noun="teklif"
            summaryTestId="offer-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function OfferRow({
  offer,
  canReadRequests,
  canReadProviderDetail,
}: {
  offer: Offer;
  canReadRequests: boolean;
  canReadProviderDetail: boolean;
}) {
  const refundRecommended = offer.refundEligibility.recommendedAction === 'FULL_REFUND';
  const customerName = offer.request.customerName;
  const customerPhone = offer.request.customerPhone;
  const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
  const requestRef = offer.request.requestNumber ?? `#${offer.request.id.slice(-8)}`;

  return (
    <tr data-testid="offer-row" data-offer-id={offer.id}>
      <td className="cell-nowrap">
        <code className="display-number">{offerRef}</code>
      </td>
      <td>
        {canReadRequests ? (
          <Link className="cell-link" href={`/requests/${offer.request.id}`}>
            <code className="display-number">{requestRef}</code>
          </Link>
        ) : (
          <code className="display-number">{requestRef}</code>
        )}
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
      <td className="is-num cell-nowrap">
        <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
      </td>
      <td className="is-num">{offer.creditCost}</td>
      <td>
        <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
      </td>
      <td>
        {refundRecommended ? (
          <span className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}>
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
          <Link className="btn btn-secondary btn-sm" href={`/offers/${offer.id}`} aria-label={`Aç: ${offerRef}`}>
            Aç
          </Link>
          {canReadRequests ? (
            <Link
              className="btn btn-ghost btn-sm"
              href={`/requests/${offer.request.id}`}
              aria-label={`Talep: ${requestRef}`}
            >
              Talep
            </Link>
          ) : null}
          {canReadProviderDetail ? (
            <Link
              className="btn btn-ghost btn-sm"
              href={`/providers/${offer.provider.id}`}
              aria-label={`Hizmet veren: ${offer.provider.businessName}`}
            >
              HV
            </Link>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
