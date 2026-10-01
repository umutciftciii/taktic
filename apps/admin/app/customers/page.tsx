import Link from 'next/link';
import {
  apiFetch,
  CUSTOMER_ORIGIN_VALUES,
  CustomerListResponse,
  CustomerOrigin,
  customerOriginBadgeClass,
  customerOriginLabel,
  CustomerSortDirection,
  CustomerSortField,
  CustomerSummary,
  formatDate,
  formatDateTime,
  requireAdmin,
} from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { provenChannels } from '../../lib/customer-verification';
import {
  customerColumnGates,
  customerDefaultSort,
  type CustomerFigures,
  customerSortFields,
  gateColumns,
} from '../../lib/cross-domain-projection';
import { buildHref, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';

/**
 * Hizmet alanlar (#7), design `list:customers` (ADMIN-DESIGN-001 Faz 3B,
 * paket 2 `19-hizmet-alanlar`).
 *
 * The API pages, sorts and filters this list itself (`GET /customers`), so the
 * screen only lays out what it is given: the shared filter bar over the same
 * query names as before, the shared table, and the shared page footer with
 * the API's own total. Nothing here is counted or guessed on the page.
 *
 * Not rendered: the design's "Excel'e aktar" (no export API) and its Durum
 * filter (the list API has no active/passive filter). The design's masked
 * telephone and e-mail are not applied either: this list has always shown
 * them in full to CUSTOMERS_READ, and masking is a separate decision (K6).
 */

const PATH = '/customers';

/** The design's ⓘ, fitted to what this screen actually shows. */
const SCREEN_INFO =
  'Platformda hesabı olan müşteriler: kendi kaydolanlar ve talep formundan otomatik oluşturulanlar. Doğrulama sütunu yalnız hesabın kendisinde kanıtlanmış e-posta ve telefonu gösterir. Bir müşteriyi açınca talepleri, aldığı teklifler, notlar ve hesap işlemleri görünür.';

const COLUMNS: DataColumn[] = [
  { key: 'customer', label: 'Müşteri' },
  { key: 'phone', label: 'Telefon' },
  { key: 'email', label: 'E-posta' },
  { key: 'verification', label: 'Doğrulama' },
  { key: 'city', label: 'Şehir' },
  { key: 'requests', label: 'Talep', align: 'end' },
  { key: 'offers', label: 'Teklif', align: 'end' },
  { key: 'accepted', label: 'Kabul', align: 'end' },
  { key: 'lastRequest', label: 'Son talep' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT_DIR: CustomerSortDirection = 'desc';

type RawSearchParams = {
  q?: string;
  city?: string;
  lastRequestFrom?: string;
  lastRequestTo?: string;
  customerOrigin?: string;
  sortBy?: string;
  sortDir?: string;
  page?: string;
  pageSize?: string;
};

type AdminCustomersPageProps = {
  searchParams: Promise<RawSearchParams>;
};

const SORT_LABEL: Record<CustomerSortField, string> = {
  name: 'İsim',
  createdAt: 'Kayıt tarihi',
  lastRequestAt: 'Son talep',
  requestCount: 'Talep sayısı',
  offerCount: 'Teklif sayısı',
  acceptedOfferCount: 'Kabul edilen teklif',
};

function normalizeSortBy(
  value: string | undefined,
  allowed: readonly CustomerSortField[],
  fallback: CustomerSortField,
): CustomerSortField {
  if (value && (allowed as readonly string[]).includes(value)) {
    return value as CustomerSortField;
  }
  return fallback;
}

function normalizeSortDir(value: string | undefined): CustomerSortDirection {
  if (value === 'asc') return 'asc';
  if (value === 'desc') return 'desc';
  return DEFAULT_SORT_DIR;
}

function normalizeCustomerOrigin(value: string | undefined): CustomerOrigin | '' {
  if (value && (CUSTOMER_ORIGIN_VALUES as readonly string[]).includes(value)) {
    return value as CustomerOrigin;
  }
  return '';
}

function normalizePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function normalizePageSize(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, 100);
}

export default async function AdminCustomersPage({ searchParams }: AdminCustomersPageProps) {
  const { can } = await requireAdmin('CUSTOMERS_READ');
  // The request and offer figures are REQUESTS_READ's and OFFERS_READ's: the
  // API leaves them out — and refuses their sorts and filters — without them,
  // so the screen neither draws those columns nor offers those controls
  // (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001).
  const figures: CustomerFigures = { requests: can('REQUESTS_READ'), offers: can('OFFERS_READ') };
  const columns = gateColumns(COLUMNS, customerColumnGates(figures));
  const sortFields = customerSortFields(figures);
  const defaultSort = customerDefaultSort(figures);

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  // The request filters are dropped, not sent, where the API would refuse them.
  const city = figures.requests ? (params.city ?? '').trim() : '';
  const lastRequestFrom = figures.requests ? (params.lastRequestFrom ?? '').trim() : '';
  const lastRequestTo = figures.requests ? (params.lastRequestTo ?? '').trim() : '';
  const customerOrigin = normalizeCustomerOrigin(params.customerOrigin);
  const sortBy = normalizeSortBy(params.sortBy, sortFields, defaultSort);
  const sortDir = normalizeSortDir(params.sortDir);
  const page = normalizePage(params.page);
  const pageSize = normalizePageSize(params.pageSize);

  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(pageSize));
  apiQuery.set('sortBy', sortBy);
  apiQuery.set('sortDir', sortDir);
  if (q) apiQuery.set('q', q);
  if (city) apiQuery.set('city', city);
  if (lastRequestFrom) apiQuery.set('lastRequestFrom', lastRequestFrom);
  if (lastRequestTo) apiQuery.set('lastRequestTo', lastRequestTo);
  if (customerOrigin) apiQuery.set('customerOrigin', customerOrigin);

  const response = await apiFetch<CustomerListResponse>(
    `/customers?${apiQuery.toString()}`,
  );

  const hasFilters = Boolean(
    q ||
      city ||
      lastRequestFrom ||
      lastRequestTo ||
      customerOrigin ||
      sortBy !== defaultSort ||
      sortDir !== DEFAULT_SORT_DIR,
  );

  // The same query names as before, so every link and bookmark still opens
  // the same list; the defaults are written as no parameter.
  const filterParams: QueryParams = {
    q,
    city,
    lastRequestFrom,
    lastRequestTo,
    customerOrigin: customerOrigin || undefined,
    sortBy: sortBy !== defaultSort ? sortBy : undefined,
    sortDir: sortDir !== DEFAULT_SORT_DIR ? sortDir : undefined,
    pageSize: pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined,
  };

  const summary =
    response.total === 0
      ? hasFilters
        ? 'Filtreye uyan müşteri yok'
        : 'Henüz kayıtlı müşteri yok'
      : hasFilters
        ? `${formatCount(response.total)} müşteri filtreye uyuyor`
        : `${formatCount(response.total)} kayıtlı müşteri · ${
            figures.requests ? 'son talebi en yeni olan önce' : 'en yeni kayıt önce'
          }`;

  return (
    <main className="customers-page">
      <PageHeader title="Hizmet alanlar" subtitle={summary} info={SCREEN_INFO} />

      {(response.meta.anonymousRequestCount ?? 0) > 0 ? (
        <div className="notice notice-warning detail-notice" role="status" data-testid="customers-anonymous-notice">
          <strong>Müşteri hesabına bağlanmamış eski talepler var.</strong>{' '}
          {response.meta.anonymousRequestCount} eski talep henüz müşteri hesabıyla eşleşmemiş.
          Backfill/onarım scripti çalıştırılmalı.
        </div>
      ) : null}

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Müşteri filtreleri"
        preserve={{ pageSize: filterParams.pageSize }}
        testId="customer-filters"
      >
        <FilterField label="Ara" htmlFor="customer-search" wide>
          <input
            id="customer-search"
            name="q"
            type="search"
            placeholder="İsim, telefon, e-posta"
            defaultValue={q}
            autoComplete="off"
          />
        </FilterField>
        {figures.requests ? (
          <>
            <FilterField label="Şehir" htmlFor="customer-city">
              <input
                id="customer-city"
                name="city"
                type="text"
                placeholder="İstanbul"
                defaultValue={city}
                autoComplete="off"
              />
            </FilterField>
            <FilterField label="Son talep (başlangıç)" htmlFor="customer-from">
              <input id="customer-from" name="lastRequestFrom" type="date" defaultValue={lastRequestFrom} />
            </FilterField>
            <FilterField label="Son talep (bitiş)" htmlFor="customer-to">
              <input id="customer-to" name="lastRequestTo" type="date" defaultValue={lastRequestTo} />
            </FilterField>
          </>
        ) : null}
        <FilterField label="Müşteri tipi" htmlFor="customer-origin">
          <select id="customer-origin" name="customerOrigin" defaultValue={customerOrigin}>
            <option value="">Tümü</option>
            {CUSTOMER_ORIGIN_VALUES.map((origin) => (
              <option key={origin} value={origin}>
                {customerOriginLabel(origin)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Sıralama" htmlFor="customer-sort">
          <select id="customer-sort" name="sortBy" defaultValue={sortBy}>
            {sortFields.map((field) => (
              <option key={field} value={field}>
                {SORT_LABEL[field]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Yön" htmlFor="customer-dir">
          <select id="customer-dir" name="sortDir" defaultValue={sortDir}>
            <option value="desc">Azalan</option>
            <option value="asc">Artan</option>
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun müşteri bulunamadı.'
                : response.total > 0
                  ? 'Bu sayfada müşteri yok.'
                  : 'Henüz kayıtlı müşteri yok.'
            }
            description={
              hasFilters
                ? 'Aramayı daraltabilir veya filtreleri temizleyebilirsiniz.'
                : 'Bir müşteri kayıt olduğunda ya da ilk talebini gönderdiğinde burada listelenir.'
            }
            action={
              hasFilters || response.total > 0 ? (
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  {hasFilters ? 'Filtreleri temizle' : 'İlk sayfaya dön'}
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="Hizmet alanlar" columns={columns} minWidth={1060} testId="customer-table">
            {response.items.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} figures={figures} />
            ))}
          </DataTable>
        )}
        {response.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={response.page}
            pageSize={response.pageSize}
            total={response.total}
            hasNextPage={response.hasNextPage}
            noun="müşteri"
            summaryTestId="customer-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function CustomerRow({ customer, figures }: { customer: CustomerSummary; figures: CustomerFigures }) {
  const displayName = customer.name ?? customer.email ?? customer.phone ?? '—';

  return (
    <tr data-testid="customer-row" data-customer-id={customer.id}>
      <td>
        <div className="cell-stack">
          <Link href={`/customers/${customer.id}`}>
            <strong>{displayName}</strong>
          </Link>
          <span className="cell-muted">Kayıt: {formatDate(customer.createdAt)}</span>
          <span className={customerOriginBadgeClass(customer.customerOrigin)}>
            {customerOriginLabel(customer.customerOrigin)}
          </span>
        </div>
      </td>
      <td className="cell-nowrap">
        {customer.phone ? (
          <a className="cell-link" href={`tel:${customer.phone}`}>
            {customer.phone}
          </a>
        ) : (
          <span className="cell-muted">—</span>
        )}
      </td>
      <td>
        {customer.email ? (
          <a className="cell-link cell-muted cell-break" href={`mailto:${customer.email}`}>
            {customer.email}
          </a>
        ) : (
          <span className="cell-muted">—</span>
        )}
      </td>
      <td>
        <CustomerVerificationCell customer={customer} />
      </td>
      {figures.requests ? (
        <>
          <td>{customer.lastRequestCity ? customer.lastRequestCity : <span className="cell-muted">—</span>}</td>
          <td className="is-num" data-testid="customer-request-count">
            {!customer.requestCount ? (
              <span className="cell-muted">0</span>
            ) : (
              <strong>{customer.requestCount}</strong>
            )}
          </td>
        </>
      ) : null}
      {figures.offers ? (
        <>
          <td className="is-num" data-testid="customer-offer-count">
            {!customer.offerCount ? <span className="cell-muted">0</span> : customer.offerCount}
          </td>
          <td className="is-num">
            {!customer.acceptedOfferCount ? (
              <span className="cell-muted">0</span>
            ) : (
              <span className="badge badge-good">{customer.acceptedOfferCount}</span>
            )}
          </td>
        </>
      ) : null}
      {figures.requests ? (
        <td>
          {customer.lastRequestAt ? (
            formatDateTime(customer.lastRequestAt)
          ) : (
            <span className="cell-muted">Henüz talep yok</span>
          )}
        </td>
      ) : null}
      <td>
        {customer.isActive ? (
          <span className="badge badge-good">Aktif</span>
        ) : (
          <span className="badge badge-bad">Pasif</span>
        )}
      </td>
      <td className="col-actions">
        <Link
          className="btn btn-secondary btn-sm"
          href={`/customers/${customer.id}`}
          aria-label={`Aç: ${displayName}`}
        >
          Aç
        </Link>
      </td>
    </tr>
  );
}

/**
 * The proven channels as scannable pills — "E-posta", "Telefon" — and a
 * muted "Yok" when neither is. Read from the two account columns alone
 * (`lib/customer-verification.ts`); a request of theirs verified by code
 * never lights one of these. Neutral rather than red for the unproven case:
 * it is a fact about the account, not a fault in it.
 */
function CustomerVerificationCell({ customer }: { customer: CustomerSummary }) {
  const proven = provenChannels(customer);
  return (
    <div className="badge-row" data-testid="customer-verification" data-verified={proven.map((b) => b.channel).join(' ')}>
      {proven.length === 0 ? (
        <span className="cell-muted" aria-label="Doğrulanmış iletişim kanalı yok">
          Yok
        </span>
      ) : (
        proven.map((badge) => (
          <span
            className="badge badge-good"
            key={badge.channel}
            aria-label={badge.ariaLabel}
            title={badge.at ? `${badge.ariaLabel} · ${formatDateTime(badge.at)}` : badge.ariaLabel}
          >
            {badge.subject}
          </span>
        ))
      )}
    </div>
  );
}
