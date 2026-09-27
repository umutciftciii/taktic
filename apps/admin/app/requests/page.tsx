import Link from 'next/link';
import {
  apiFetch,
  formatBudgetRange,
  formatDateTime,
  listCatalogueForFilter,
  qualityBadgeClass,
  qualityLabel,
  QualityLabel,
  requestStatusLabel,
  requireAdmin,
  ServiceRequest,
  ServiceRequestStatus,
  statusBadgeClass,
} from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { InfoPopover } from '../../components/info-popover';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';
import { buildHref, parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount, pageWindow } from '../../lib/pagination';

/**
 * Talepler (#2), design `requests` (ADMIN-DESIGN-001 Faz 3A).
 *
 * The API returns the whole list (`GET /service-requests` has no paging), and
 * every filter is applied here, on the server, exactly as before. What the
 * design adds on top is only presentation of data this page already holds:
 * the saved views count their rows from the same list, and the table is cut
 * into pages of 50 so a long list is not one enormous table.
 *
 * Not rendered: the design's "Excel'e aktar" and "Elle talep ekle". Neither
 * has an API behind it (ADMIN-ACTIONS-006 and -007); a button that did nothing
 * would be worse than none.
 */

const PATH = '/requests';
const PAGE_SIZE = 50;

/** The design's ⓘ, as written — it matches what this screen does. */
const SCREEN_INFO =
  'Müşterilerin doldurduğu hizmet talepleri burada. Yayında olan bir talebi hizmet verenler görür ve teklif verir. Senin işin: yayına girmemiş olanlara karar vermek, şikayet edilenleri incelemek ve kalite puanı düşük olanları gözden geçirmek.';

/**
 * The design's quality ⓘ, corrected to the API's real scoring
 * (service-requests.service.ts): no photo and no phone-verification component,
 * and the bands are 80 / 50, not 70 / 40.
 */
const QUALITY_INFO =
  '100 üzerinden bir puan: müşteri formu ne kadar eksiksiz doldurdu — telefon ve ad, il/ilçe ve konum ayrıntısı, bütçe, tercih tarihi, aciliyet, en az birkaç cümlelik açıklama ve kategori sorularının yanıtları. 80 ve üzeri "Yüksek", 50–79 "Orta", 50\'nin altı "Düşük" sayılır. Puan talebi kendiliğinden gizlemez; yalnız dikkat çeker.';

/**
 * With auto-publish on, a submitted request is approved the moment it is
 * submitted, so "Yeni Talep" stops being the moderation inbox. Said before the
 * operator filters on it.
 */
const STATUS_INFO =
  'Otomatik yayın açıkken yeni talepler bu kuyruğa düşmez; burada yalnız eski talepler ve doğrulama bekleyenler var.';

type RawSearchParams = {
  q?: string;
  status?: string;
  quality?: string;
  category?: string;
  city?: string;
  from?: string;
  to?: string;
  page?: string;
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
  { label: 'Eşleşti', value: 'MATCHED' },
  { label: 'Tamamlandı', value: 'COMPLETED' },
  { label: 'Reddedildi', value: 'REJECTED' },
  { label: 'İptal Edildi', value: 'CANCELLED' },
  { label: 'Süresi Doldu', value: 'EXPIRED' },
];

/**
 * The saved views: the status filter's values an operator works through, in
 * that order. Every other status stays one select away in the filter bar.
 */
const VIEW_STATUSES: ServiceRequestStatus[] = ['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'MATCHED'];

const qualityFilters: Array<{ label: string; value: QualityFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Yüksek', value: 'HIGH' },
  { label: 'Orta', value: 'MEDIUM' },
  { label: 'Düşük', value: 'LOW' },
];

const COLUMNS: DataColumn[] = [
  { key: 'no', label: 'Talep no' },
  { key: 'submittedAt', label: 'Geldiği tarih' },
  { key: 'category', label: 'Hizmet' },
  { key: 'customer', label: 'Müşteri' },
  { key: 'location', label: 'Konum' },
  { key: 'budget', label: 'Bütçe' },
  { key: 'quality', label: 'Kalite' },
  { key: 'status', label: 'Durum' },
  { key: 'offers', label: 'Teklif', align: 'end' },
  { key: 'actions', label: 'İşlemler', srOnly: true },
];

function normalizeStatus(value: string | undefined): StatusFilter {
  const upper = value?.toUpperCase();
  return statusFilters.some((filter) => filter.value === upper) && upper !== 'ALL'
    ? (upper as ServiceRequestStatus)
    : 'all';
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

/**
 * The lifecycle clock behind the status badge.
 *
 * An APPROVED request without an approval time is worth calling out: it was
 * approved before the field existed, so the 14-day expiry and the day-7
 * reminder will never act on it.
 */
function lifecycleNotes(request: ServiceRequest): string[] {
  const notes: string[] = [];

  if (request.status === 'EXPIRED' && request.expiredAt) {
    notes.push(`Süre doldu · ${formatDateTime(request.expiredAt)}`);
  } else if (request.status === 'APPROVED') {
    notes.push(
      request.approvedAt
        ? `Onay · ${formatDateTime(request.approvedAt)}`
        : 'Onay zamanı kayıtlı değil',
    );
  }

  if (request.reminderSentAt) {
    notes.push(`Hatırlatma · ${formatDateTime(request.reminderSentAt)}`);
  }

  return notes;
}

export default async function AdminRequestsPage({ searchParams }: AdminRequestsPageProps) {
  const { can } = await requireAdmin('REQUESTS_READ');
  const canReadOffers = can('OFFERS_READ');
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const status = normalizeStatus(params.status);
  const quality = normalizeQuality(params.quality);
  const categorySlug = (params.category ?? '').trim();
  const cityFilter = (params.city ?? '').trim();
  const fromRaw = (params.from ?? '').trim();
  const toRaw = (params.to ?? '').trim();
  const fromDate = parseDateBoundary(fromRaw, 'start');
  const toDate = parseDateBoundary(toRaw, 'end');
  const page = parsePage(params.page);

  const [requests, categories] = await Promise.all([
    apiFetch<ServiceRequest[]>('/service-requests'),
    listCatalogueForFilter(),
  ]);

  const normalizedQuery = toLower(query);
  const normalizedCity = toLower(cityFilter);

  // Every filter except the status: the saved views count from this.
  const matchingOtherFilters = requests.filter((request) => {
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

  const filtered =
    status === 'all'
      ? matchingOtherFilters
      : matchingOtherFilters.filter((request) => request.status === status);

  const range = pageWindow({ page, pageSize: PAGE_SIZE, total: filtered.length });
  const pageRows = filtered.slice(range.start > 0 ? range.start - 1 : 0, range.end);

  const sortedCategories = [...categories].sort((a, b) => a.name.localeCompare(b.name, 'tr-TR'));

  const hasFilters =
    query.length > 0 ||
    status !== 'all' ||
    quality !== 'all' ||
    categorySlug.length > 0 ||
    cityFilter.length > 0 ||
    fromRaw.length > 0 ||
    toRaw.length > 0;

  const filterParams: QueryParams = {
    q: query,
    status: status === 'all' ? '' : status,
    quality: quality === 'all' ? '' : quality,
    category: categorySlug,
    city: cityFilter,
    from: fromRaw,
    to: toRaw,
  };

  // Exact counts: the whole list is on this page already.
  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: matchingOtherFilters.length, testId: 'request-view-all' },
    ...VIEW_STATUSES.map((value) => ({
      key: value,
      label: requestStatusLabel(value),
      count: matchingOtherFilters.filter((request) => request.status === value).length,
      testId: `request-view-${value.toLowerCase()}`,
    })),
  ];

  const summary =
    requests.length === 0
      ? 'Henüz talep yok'
      : hasFilters
        ? `${formatCount(requests.length)} talebin ${formatCount(filtered.length)} tanesi filtreye uyuyor`
        : `${formatCount(requests.length)} talep · en yeni önce`;

  return (
    <main className="requests-page">
      <PageHeader title="Talepler" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Talep görünümleri"
        items={views}
        active={status === 'all' ? '' : status}
        path={PATH}
        params={filterParams}
        param="status"
        testId="request-views"
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Talep filtreleri"
        testId="request-filters"
      >
        <FilterField label="Ara" htmlFor="request-search" wide>
          <input
            id="request-search"
            name="q"
            type="search"
            placeholder="Müşteri, telefon, kategori, şehir"
            defaultValue={query}
            autoComplete="off"
          />
        </FilterField>
        <FilterField
          label="Durum"
          htmlFor="request-status"
          info={
            <InfoPopover label="Yeni talepler neden bu kuyrukta değil?" size="sm">
              {STATUS_INFO}
            </InfoPopover>
          }
        >
          <select id="request-status" name="status" defaultValue={status}>
            {statusFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField
          label="Kalite"
          htmlFor="request-quality"
          info={
            <InfoPopover label="Talep kalitesi nedir?" size="sm">
              {QUALITY_INFO}
            </InfoPopover>
          }
        >
          <select id="request-quality" name="quality" defaultValue={quality}>
            {qualityFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Kategori" htmlFor="request-category">
          <select id="request-category" name="category" defaultValue={categorySlug}>
            <option value="">Tümü</option>
            {sortedCategories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Şehir" htmlFor="request-city">
          <input
            id="request-city"
            name="city"
            type="text"
            placeholder="İstanbul"
            defaultValue={cityFilter}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Başlangıç" htmlFor="request-from">
          <input id="request-from" name="from" type="date" defaultValue={fromRaw} />
        </FilterField>
        <FilterField label="Bitiş" htmlFor="request-to">
          <input id="request-to" name="to" type="date" defaultValue={toRaw} />
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {filtered.length === 0 ? (
          requests.length === 0 ? (
            <EmptyState
              title="Henüz talep yok."
              description="Müşteri talepleri geldikçe burada listelenecek."
            />
          ) : (
            <EmptyState
              title="Filtrelere uygun talep bulunamadı."
              description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
              action={
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Filtreleri temizle
                </Link>
              }
            />
          )
        ) : (
          <DataTable caption="Talepler" columns={COLUMNS} minWidth={1120} testId="request-table">
            {pageRows.map((request) => (
              <RequestRow key={request.id} request={request} canReadOffers={canReadOffers} />
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
            noun="talep"
            summaryTestId="request-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function RequestRow({ request, canReadOffers }: { request: ServiceRequest; canReadOffers: boolean }) {
  const offerCount =
    typeof request.offersCount === 'number'
      ? request.offersCount
      : typeof request._count?.offers === 'number'
        ? request._count.offers
        : null;
  const secondaryLocation = request.neighborhood || request.addressNote;
  const requestRef = request.requestNumber ?? `#${request.id.slice(-8)}`;

  return (
    <tr data-testid="request-row" data-request-id={request.id}>
      <td className="cell-nowrap">
        <code className="display-number">{requestRef}</code>
      </td>
      <td>{formatDateTime(request.submittedAt)}</td>
      <td>
        <div className="cell-stack">
          <strong>{request.category.name}</strong>
          {request.category.slug ? <span className="cell-muted">{request.category.slug}</span> : null}
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
            <a className="cell-link cell-muted cell-break" href={`mailto:${request.customerEmail}`}>
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
          {secondaryLocation ? <span className="cell-muted">{secondaryLocation}</span> : null}
        </div>
      </td>
      <td>{formatBudgetRange(request.budgetMin, request.budgetMax)}</td>
      <td>
        <div className="quality-cell">
          <span className={qualityBadgeClass(request.qualityLabel)}>
            {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
          </span>
          <div className="request-quality-bar request-quality-bar-sm" role="presentation">
            <span
              className={`request-quality-bar-fill request-quality-bar-fill-${request.qualityLabel.toLowerCase()}`}
              style={{ width: `${Math.min(100, Math.max(0, request.qualityScore))}%` }}
            />
          </div>
        </div>
      </td>
      <td>
        <div className="cell-stack">
          <span className={statusBadgeClass(request.status)}>{requestStatusLabel(request.status)}</span>
          {lifecycleNotes(request).map((note) => (
            <span className="cell-muted" key={note}>
              {note}
            </span>
          ))}
        </div>
      </td>
      <td className="is-num">
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
          <Link
            className="btn btn-secondary btn-sm"
            href={`/requests/${request.id}`}
            aria-label={`Aç: ${requestRef}`}
          >
            Aç
          </Link>
          {canReadOffers ? (
            <Link
              className="btn btn-ghost btn-sm"
              href={`/offers?requestId=${request.id}`}
              aria-label={`Teklifler: ${requestRef}`}
            >
              Teklifler
            </Link>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
