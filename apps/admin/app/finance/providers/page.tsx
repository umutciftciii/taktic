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
import { buildHref, parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';
import { formatSignedCount } from '../../../lib/finance-format';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { FilterBar, FilterField } from '../../../components/filter-bar';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';

/**
 * Every provider's credit balance and money summary.
 *
 * ADMIN-DESIGN-001 Faz 3D (paket 2 `28-isletme-bakiyeleri`, prototip
 * `list:balances`). The design shows six columns; this screen keeps all eleven
 * of the old table (K7) inside the shared table's own scroll box — the page
 * never widens, the table scrolls sideways on a narrow window. The nine sort
 * fields, the search and the page size of 25 are the same query parameters as
 * before.
 *
 * Not rendered: "Bu ay harcadığı" (the API has no per-period breakdown per
 * provider), "Son teklif" (not in this read — "Son hareket" is the nearest
 * true value and stays), the design's Durum and Tarih filters (the API takes
 * neither) and "Excel'e aktar" (no export exists).
 */

const PATH = '/finance/providers';
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_SORT_BY: ProviderFinanceSortField = 'lastTransactionAt';
const DEFAULT_SORT_DIR: ProviderFinanceSortDirection = 'desc';

/** The design's ⓘ, kept to what the balance is. */
const SCREEN_INFO =
  'Hizmet verenlerin elinde duran, henüz harcanmamış kredi ve her işletmenin ödeme ile kredi hareketi özeti. Bu krediler satılmış ama karşılığı henüz verilmemiş hizmettir. Bakiyesi biten işletme teklif veremez.';

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

const COLUMNS: DataColumn[] = [
  { key: 'provider', label: 'İşletme' },
  { key: 'status', label: 'Durum' },
  { key: 'balance', label: 'Bakiye', align: 'end' },
  { key: 'paid', label: 'Toplam ödeme', align: 'end' },
  { key: 'purchased', label: 'Satın alınan kredi', align: 'end' },
  { key: 'spent', label: 'Harcanan kredi', align: 'end' },
  { key: 'refunded', label: 'İade edilen kredi', align: 'end' },
  { key: 'manual', label: 'Manuel net', align: 'end' },
  { key: 'lastPayment', label: 'Son ödeme' },
  { key: 'lastTransaction', label: 'Son hareket' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

type RawSearchParams = {
  q?: string;
  sortBy?: string;
  sortDir?: string;
  page?: string;
};

type AdminProviderFinancePageProps = {
  searchParams: Promise<RawSearchParams>;
};

function normalizeSortBy(value: string | undefined): ProviderFinanceSortField {
  if (value && (PROVIDER_FINANCE_SORT_FIELDS as readonly string[]).includes(value)) {
    return value as ProviderFinanceSortField;
  }
  return DEFAULT_SORT_BY;
}

function normalizeSortDir(value: string | undefined): ProviderFinanceSortDirection {
  if (value === 'desc') return 'desc';
  if (value === 'asc') return 'asc';
  return DEFAULT_SORT_DIR;
}

function formatDateOrDash(value: string | null | undefined): string {
  return value ? formatDateTime(value) : '—';
}

export default async function AdminProviderFinancePage({
  searchParams,
}: AdminProviderFinancePageProps) {
  const { can } = await requireAdmin('FINANCE_READ');
  // The provider credit screen, the ledger and the manual adjustments screen
  // all sit behind FINANCE_LEDGER_READ — a FINANCE_READ-only role sees the
  // balances without links that would land on /yetkisiz.
  const canOpenLedger = can('FINANCE_LEDGER_READ');

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const sortBy = normalizeSortBy(params.sortBy);
  const sortDir = normalizeSortDir(params.sortDir);
  const page = parsePage(params.page);

  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(DEFAULT_PAGE_SIZE));
  apiQuery.set('sortBy', sortBy);
  apiQuery.set('sortDir', sortDir);
  if (q) apiQuery.set('q', q);

  const response = await apiFetch<ProviderFinanceResponse>(`/finance/providers?${apiQuery.toString()}`);

  const hasFilters = Boolean(q || sortBy !== DEFAULT_SORT_BY || sortDir !== DEFAULT_SORT_DIR);
  // The defaults are written as no parameter, so the plain address and the
  // default order are one URL.
  const filterParams: QueryParams = {
    q,
    sortBy: sortBy === DEFAULT_SORT_BY ? '' : sortBy,
    sortDir: sortDir === DEFAULT_SORT_DIR ? '' : sortDir,
  };

  const summary =
    response.total === 0
      ? q
        ? 'Bu aramayla işletme yok'
        : 'Henüz hizmet veren yok'
      : `${formatCount(response.total)} işletme · ${SORT_LABEL[sortBy].toLocaleLowerCase('tr-TR')} sırasıyla (${sortDir === 'asc' ? 'artan' : 'azalan'})`;

  return (
    <main className="finance-list-page">
      <PageHeader
        title="İşletme bakiyeleri"
        subtitle={summary}
        info={SCREEN_INFO}
        actions={
          <>
            {canOpenLedger ? (
              <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
                Kredi hareketleri
              </Link>
            ) : null}
            <Link className="btn btn-secondary btn-sm" href="/finance">
              Finans özeti
            </Link>
          </>
        }
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="İşletme bakiyesi filtreleri"
        testId="provider-finance-filters"
      >
        <FilterField label="Ara" htmlFor="provider-finance-search" wide>
          <input
            id="provider-finance-search"
            name="q"
            type="search"
            placeholder={can('PROVIDERS_READ') ? 'İşletme, telefon, e-posta' : 'İşletme'}
            defaultValue={q}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Sıralama" htmlFor="provider-finance-sort">
          <select id="provider-finance-sort" name="sortBy" defaultValue={sortBy}>
            {PROVIDER_FINANCE_SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {SORT_LABEL[field]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Yön" htmlFor="provider-finance-dir">
          <select id="provider-finance-dir" name="sortDir" defaultValue={sortDir}>
            <option value="asc">Artan</option>
            <option value="desc">Azalan</option>
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {response.items.length === 0 ? (
          <EmptyState
            title={
              q
                ? 'Filtreye uygun hizmet veren bulunamadı.'
                : response.total > 0
                  ? 'Bu sayfada hizmet veren yok.'
                  : 'Henüz hizmet veren yok.'
            }
            description={
              q
                ? 'Aramayı daraltabilir veya temizleyebilirsiniz.'
                : 'Hizmet verenler eklendikçe kredi ve ödeme özetleri burada görünecek.'
            }
            action={
              hasFilters ? (
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Filtreleri temizle
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="İşletme bakiyeleri" columns={COLUMNS} minWidth={1320} testId="provider-finance-table">
            {response.items.map((item) => (
              <ProviderFinanceRow key={item.provider.id} item={item} canOpenLedger={canOpenLedger} />
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
            noun="işletme"
            summaryTestId="provider-finance-page-summary"
          />
        ) : null}
      </div>
    </main>
  );
}

function ProviderFinanceRow({ item, canOpenLedger }: { item: ProviderFinanceItem; canOpenLedger: boolean }) {
  const { provider } = item;
  const balanceClass =
    item.currentBalance > 0 ? 'badge badge-good' : item.currentBalance < 0 ? 'badge badge-bad' : 'badge badge-muted';
  const manualNetClass =
    item.manualNetCredits > 0
      ? 'badge badge-good'
      : item.manualNetCredits < 0
        ? 'badge badge-bad'
        : 'badge badge-muted';
  const creditsHref = `/providers/${provider.id}/credits`;

  return (
    <tr data-testid="provider-finance-row">
      <td>
        {/*
          May break anywhere: a business name without spaces or an e-mail
          address is one unbreakable word, and one of those alone held this
          column wide enough to push the table past a 1440px window.
        */}
        <div className="cell-stack cell-break">
          {canOpenLedger ? (
            <Link href={creditsHref}>
              <strong>{provider.businessName}</strong>
            </Link>
          ) : (
            <strong>{provider.businessName}</strong>
          )}
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
        <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
      </td>
      <td className="is-num">
        <span className={balanceClass} data-testid="provider-finance-balance">
          {formatCount(item.currentBalance)}
        </span>
      </td>
      <td className="is-num cell-nowrap">{formatPrice(item.totalPaidAmount)}</td>
      <td className="is-num">{formatCount(item.totalCreditsPurchased)}</td>
      <td className="is-num">{formatCount(item.totalCreditsSpent)}</td>
      <td className="is-num">
        {item.totalCreditsRefunded === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          formatCount(item.totalCreditsRefunded)
        )}
      </td>
      <td className="is-num">
        <span className={manualNetClass}>{formatSignedCount(item.manualNetCredits)}</span>
      </td>
      <td className="cell-nowrap">{formatDateOrDash(item.lastPaymentAt)}</td>
      <td className="cell-nowrap">{formatDateOrDash(item.lastTransactionAt)}</td>
      <td className="col-actions">
        {canOpenLedger ? (
          <div className="inline-actions">
            <Link
              className="btn btn-secondary btn-sm"
              href={creditsHref}
              aria-label={`Kredi ekranını aç: ${provider.businessName}`}
            >
              Aç
            </Link>
            <Link className="btn btn-ghost btn-sm" href={`/finance/credit-ledger?providerId=${provider.id}`}>
              Hareketler
            </Link>
            <Link className="btn btn-ghost btn-sm" href={`/finance/manual-adjustments?providerId=${provider.id}`}>
              Elle işlemler
            </Link>
          </div>
        ) : (
          <span className="cell-muted">—</span>
        )}
      </td>
    </tr>
  );
}
