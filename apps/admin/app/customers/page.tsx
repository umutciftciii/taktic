import Link from 'next/link';
import {
  apiFetch,
  CUSTOMER_SORT_FIELDS,
  CustomerListResponse,
  CustomerSortDirection,
  CustomerSortField,
  CustomerSummary,
  formatDate,
  formatDateTime,
  requireAdmin,
} from '../../lib/api';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT_BY: CustomerSortField = 'lastRequestAt';
const DEFAULT_SORT_DIR: CustomerSortDirection = 'desc';

type RawSearchParams = {
  q?: string;
  city?: string;
  lastRequestFrom?: string;
  lastRequestTo?: string;
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

function normalizeSortBy(value: string | undefined): CustomerSortField {
  if (value && (CUSTOMER_SORT_FIELDS as readonly string[]).includes(value)) {
    return value as CustomerSortField;
  }
  return DEFAULT_SORT_BY;
}

function normalizeSortDir(value: string | undefined): CustomerSortDirection {
  if (value === 'asc') return 'asc';
  if (value === 'desc') return 'desc';
  return DEFAULT_SORT_DIR;
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

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === null) continue;
    query.set(key, String(value));
  }
  const str = query.toString();
  return str ? `?${str}` : '';
}

function buildPageHref(
  baseParams: Record<string, string | number | undefined>,
  page: number,
): string {
  const params = { ...baseParams };
  if (page <= 1) delete params.page;
  else params.page = page;
  return `/customers${buildQueryString(params)}`;
}

export default async function AdminCustomersPage({ searchParams }: AdminCustomersPageProps) {
  await requireAdmin();

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const city = (params.city ?? '').trim();
  const lastRequestFrom = (params.lastRequestFrom ?? '').trim();
  const lastRequestTo = (params.lastRequestTo ?? '').trim();
  const sortBy = normalizeSortBy(params.sortBy);
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

  const response = await apiFetch<CustomerListResponse>(
    `/customers?${apiQuery.toString()}`,
  );

  const hasFilters = Boolean(
    q ||
      city ||
      lastRequestFrom ||
      lastRequestTo ||
      sortBy !== DEFAULT_SORT_BY ||
      sortDir !== DEFAULT_SORT_DIR,
  );

  const baseParams: Record<string, string | number | undefined> = {
    q,
    city,
    lastRequestFrom,
    lastRequestTo,
    sortBy: sortBy !== DEFAULT_SORT_BY ? sortBy : undefined,
    sortDir: sortDir !== DEFAULT_SORT_DIR ? sortDir : undefined,
    pageSize: pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined,
  };

  const startIndex = response.total === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const endIndex = Math.min(response.page * response.pageSize, response.total);

  return (
    <main className="customers-page">
      <PageHeader
        title="Hizmet Alanlar"
        subtitle="Kayıtlı müşterileri inceleyin, talep ve teklif geçmişlerini takip edin."
      />

      {response.meta.anonymousRequestCount > 0 ? (
        <div
          className="notice"
          role="status"
          style={{
            marginBottom: 16,
            padding: '10px 14px',
            border: '1px solid var(--border, #e5e7eb)',
            borderRadius: 8,
            background: 'var(--muted-bg, #f9fafb)',
            fontSize: 13,
          }}
        >
          <strong>Müşteri hesabına bağlanmamış eski talepler var</strong>
          <div className="muted" style={{ marginTop: 4 }}>
            {response.meta.anonymousRequestCount} eski talep henüz müşteri
            hesabıyla eşleşmemiş. Backfill/onarım scripti çalıştırılmalı.
          </div>
        </div>
      ) : null}

      <form className="admin-toolbar" method="get" action="/customers">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="customer-search">Ara</label>
          <input
            id="customer-search"
            name="q"
            type="search"
            placeholder="İsim, telefon, e-posta"
            defaultValue={q}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="customer-city">Şehir</label>
          <input
            id="customer-city"
            name="city"
            type="text"
            placeholder="İstanbul"
            defaultValue={city}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="customer-from">Son talep (başlangıç)</label>
          <input
            id="customer-from"
            name="lastRequestFrom"
            type="date"
            defaultValue={lastRequestFrom}
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="customer-to">Son talep (bitiş)</label>
          <input
            id="customer-to"
            name="lastRequestTo"
            type="date"
            defaultValue={lastRequestTo}
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="customer-sort">Sıralama</label>
          <select id="customer-sort" name="sortBy" defaultValue={sortBy}>
            {CUSTOMER_SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {SORT_LABEL[field]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="customer-dir">Yön</label>
          <select id="customer-dir" name="sortDir" defaultValue={sortDir}>
            <option value="desc">Azalan</option>
            <option value="asc">Artan</option>
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {response.total === 0
              ? '0 müşteri'
              : `${startIndex}-${endIndex} / ${response.total} müşteri`}
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/customers">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      <SectionCard
        title="Müşteri listesi"
        subtitle={`Sayfa ${response.page} · ${response.pageSize} müşteri/sayfa`}
        padded={false}
      >
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun müşteri bulunamadı.'
                : 'Henüz kayıtlı müşteri yok.'
            }
            description={
              hasFilters
                ? 'Aramayı daraltabilir veya filtreleri temizleyebilirsiniz.'
                : 'Kayıtlı müşteriler eklendikçe burada listelenecek.'
            }
            action={
              hasFilters ? (
                <Link className="btn btn-secondary btn-sm" href="/customers">
                  Filtreleri temizle
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Müşteri</th>
                  <th>Telefon</th>
                  <th>E-posta</th>
                  <th>Şehir</th>
                  <th className="col-num">Talep</th>
                  <th className="col-num">Teklif</th>
                  <th className="col-num">Kabul</th>
                  <th>Son Talep</th>
                  <th>Kayıt Tarihi</th>
                  <th>Durum</th>
                  <th className="col-actions">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {response.items.map((customer) => (
                  <CustomerRow key={customer.id} customer={customer} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {response.total > response.pageSize ? (
        <nav
          className="inline-actions"
          style={{ marginTop: 16, justifyContent: 'space-between' }}
        >
          {response.page > 1 ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={buildPageHref(baseParams, response.page - 1)}
            >
              ← Önceki
            </Link>
          ) : (
            <span />
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            Sayfa {response.page}
          </span>
          {response.hasNextPage ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={buildPageHref(baseParams, response.page + 1)}
            >
              Sonraki →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}

function CustomerRow({ customer }: { customer: CustomerSummary }) {
  const displayName = customer.name ?? customer.email ?? customer.phone ?? '—';

  return (
    <tr>
      <td>
        <div className="cell-stack">
          <Link href={`/customers/${customer.id}`}>
            <strong>{displayName}</strong>
          </Link>
          <span className="cell-muted">Kayıtlı müşteri</span>
        </div>
      </td>
      <td>
        {customer.phone ? (
          <a className="cell-link" href={`tel:${customer.phone}`}>
            {customer.phone}
          </a>
        ) : (
          <span className="cell-muted">-</span>
        )}
      </td>
      <td>
        {customer.email ? (
          <a className="cell-link cell-muted" href={`mailto:${customer.email}`}>
            {customer.email}
          </a>
        ) : (
          <span className="cell-muted">-</span>
        )}
      </td>
      <td>
        {customer.lastRequestCity ? (
          customer.lastRequestCity
        ) : (
          <span className="cell-muted">-</span>
        )}
      </td>
      <td className="col-num">
        {customer.requestCount === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          <strong>{customer.requestCount}</strong>
        )}
      </td>
      <td className="col-num">
        {customer.offerCount === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          customer.offerCount
        )}
      </td>
      <td className="col-num">
        {customer.acceptedOfferCount === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          <span className="badge badge-good">{customer.acceptedOfferCount}</span>
        )}
      </td>
      <td>
        {customer.lastRequestAt ? (
          formatDateTime(customer.lastRequestAt)
        ) : (
          <span className="cell-muted">Henüz talep yok</span>
        )}
      </td>
      <td>{formatDate(customer.createdAt)}</td>
      <td>
        {customer.isActive ? (
          <span className="badge badge-good">Aktif</span>
        ) : (
          <span className="badge badge-bad">Pasif</span>
        )}
      </td>
      <td className="col-actions">
        <div className="inline-actions">
          <Link className="btn btn-secondary btn-sm" href={`/customers/${customer.id}`}>
            Detay
          </Link>
        </div>
      </td>
    </tr>
  );
}
