import Link from 'next/link';
import {
  apiFetch,
  PROVIDER_FINANCE_SORT_FIELDS,
  ProviderFinanceItem,
  ProviderFinanceResponse,
  ProviderFinanceSortDirection,
  ProviderFinanceSortField,
  formatDateTime,
  formatPrice,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_SORT_BY: ProviderFinanceSortField = 'lastTransactionAt';
const DEFAULT_SORT_DIR: ProviderFinanceSortDirection = 'desc';

type RawSearchParams = {
  q?: string;
  sortBy?: string;
  sortDir?: string;
  page?: string;
};

type AdminProviderFinancePageProps = {
  searchParams: Promise<RawSearchParams>;
};

const SORT_LABEL: Record<ProviderFinanceSortField, string> = {
  businessName: 'İşletme adı',
  currentBalance: 'Mevcut kredi',
  totalPaidAmount: 'Toplam ödeme',
  totalCreditsPurchased: 'Satın alınan kredi',
  totalCreditsSpent: 'Harcanan kredi',
  totalCreditsRefunded: 'İade edilen kredi',
  manualNetCredits: 'Manuel net',
  lastPaymentAt: 'Son ödeme',
  lastTransactionAt: 'Son hareket',
};

function normalizeSortBy(value: string | undefined): ProviderFinanceSortField {
  if (
    value &&
    (PROVIDER_FINANCE_SORT_FIELDS as readonly string[]).includes(value)
  ) {
    return value as ProviderFinanceSortField;
  }
  return DEFAULT_SORT_BY;
}

function normalizeSortDir(value: string | undefined): ProviderFinanceSortDirection {
  if (value === 'desc') return 'desc';
  if (value === 'asc') return 'asc';
  return DEFAULT_SORT_DIR;
}

function normalizePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
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
  return `/finance/providers${buildQueryString(params)}`;
}

function formatDateOrDash(value: string | null | undefined): string {
  return value ? formatDateTime(value) : '-';
}

export default async function AdminProviderFinancePage({
  searchParams,
}: AdminProviderFinancePageProps) {
  await requireAdmin();

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const sortBy = normalizeSortBy(params.sortBy);
  const sortDir = normalizeSortDir(params.sortDir);
  const page = normalizePage(params.page);

  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(DEFAULT_PAGE_SIZE));
  apiQuery.set('sortBy', sortBy);
  apiQuery.set('sortDir', sortDir);
  if (q) apiQuery.set('q', q);

  const response = await apiFetch<ProviderFinanceResponse>(
    `/finance/providers?${apiQuery.toString()}`,
  );

  const hasFilters = Boolean(q || sortBy !== DEFAULT_SORT_BY || sortDir !== DEFAULT_SORT_DIR);
  const baseParams = { q, sortBy, sortDir };

  const startIndex = response.total === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const endIndex = Math.min(response.page * response.pageSize, response.total);

  return (
    <main>
      <PageHeader
        title="Provider Finans Bakiyeleri"
        subtitle="Hizmet verenlerin kredi bakiyesi, ödeme ve kredi hareketi özetleri."
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
              Kredi Hareketleri
            </Link>
            <Link className="btn btn-ghost btn-sm" href="/finance">
              Finans Dashboard
            </Link>
          </>
        }
      />

      <form className="admin-toolbar" method="get" action="/finance/providers">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="provider-finance-search">Ara</label>
          <input
            id="provider-finance-search"
            name="q"
            type="search"
            placeholder="İşletme, telefon, e-posta"
            defaultValue={q}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="provider-finance-sort">Sıralama</label>
          <select id="provider-finance-sort" name="sortBy" defaultValue={sortBy}>
            {PROVIDER_FINANCE_SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {SORT_LABEL[field]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="provider-finance-dir">Yön</label>
          <select id="provider-finance-dir" name="sortDir" defaultValue={sortDir}>
            <option value="asc">Artan</option>
            <option value="desc">Azalan</option>
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {response.total === 0
              ? '0 hizmet veren'
              : `${startIndex}-${endIndex} / ${response.total} hizmet veren`}
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/finance/providers">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      <SectionCard
        title="Provider listesi"
        subtitle={`Sayfa ${response.page} · ${response.pageSize} hizmet veren/sayfa`}
        padded={false}
      >
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun hizmet veren bulunamadı.'
                : 'Henüz hizmet veren yok.'
            }
            description={
              hasFilters
                ? 'Aramayı daraltabilir veya sıralamayı değiştirebilirsiniz.'
                : 'Hizmet verenler eklendikçe kredi ve ödeme özetleri burada görünecek.'
            }
            action={
              hasFilters ? (
                <Link className="btn btn-secondary btn-sm" href="/finance/providers">
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
                  <th>Hizmet Veren</th>
                  <th>Durum</th>
                  <th className="col-num">Mevcut Kredi</th>
                  <th className="col-num">Toplam Ödeme</th>
                  <th className="col-num">Satın Alınan Kredi</th>
                  <th className="col-num">Harcanan Kredi</th>
                  <th className="col-num">İade Edilen Kredi</th>
                  <th className="col-num">Manuel Net</th>
                  <th>Son Ödeme</th>
                  <th>Son Hareket</th>
                  <th className="col-actions">Aksiyon</th>
                </tr>
              </thead>
              <tbody>
                {response.items.map((item) => (
                  <ProviderFinanceRow key={item.provider.id} item={item} />
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

function ProviderFinanceRow({ item }: { item: ProviderFinanceItem }) {
  const { provider } = item;
  const balanceClass =
    item.currentBalance > 0
      ? 'badge badge-good'
      : item.currentBalance < 0
        ? 'badge badge-bad'
        : 'badge badge-muted';
  const manualNetClass =
    item.manualNetCredits > 0
      ? 'badge badge-good'
      : item.manualNetCredits < 0
        ? 'badge badge-bad'
        : 'badge badge-muted';
  const manualNetText =
    item.manualNetCredits > 0
      ? `+${item.manualNetCredits}`
      : String(item.manualNetCredits);

  return (
    <tr>
      <td>
        <div className="cell-stack">
          <Link href={`/providers/${provider.id}/credits`}>
            <strong>{provider.businessName}</strong>
          </Link>
          {provider.phone || provider.email ? (
            <span className="cell-muted">
              {provider.phone}
              {provider.phone && provider.email ? ' · ' : ''}
              {provider.email ?? ''}
            </span>
          ) : null}
        </div>
      </td>
      <td>
        <span className={statusBadgeClass(provider.status)}>
          {statusLabel(provider.status)}
        </span>
      </td>
      <td className="col-num">
        <span className={balanceClass}>{item.currentBalance}</span>
      </td>
      <td className="col-num">{formatPrice(item.totalPaidAmount)}</td>
      <td className="col-num">{item.totalCreditsPurchased}</td>
      <td className="col-num">{item.totalCreditsSpent}</td>
      <td className="col-num">
        {item.totalCreditsRefunded === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          item.totalCreditsRefunded
        )}
      </td>
      <td className="col-num">
        <span className={manualNetClass}>{manualNetText}</span>
      </td>
      <td>{formatDateOrDash(item.lastPaymentAt)}</td>
      <td>{formatDateOrDash(item.lastTransactionAt)}</td>
      <td className="col-actions">
        <div className="inline-actions">
          <Link
            className="btn btn-secondary btn-sm"
            href={`/providers/${provider.id}/credits`}
          >
            Kredi Ekranı
          </Link>
          <Link
            className="btn btn-ghost btn-sm"
            href={`/finance/credit-ledger?providerId=${provider.id}`}
          >
            Ledger
          </Link>
          <Link
            className="btn btn-ghost btn-sm"
            href={`/finance/manual-adjustments?providerId=${provider.id}`}
          >
            Manuel İşlemler
          </Link>
        </div>
      </td>
    </tr>
  );
}
