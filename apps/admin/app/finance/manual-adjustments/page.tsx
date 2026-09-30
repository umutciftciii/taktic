import Link from 'next/link';
import {
  apiFetch,
  CreditLedgerEntry,
  CreditLedgerResponse,
  formatDateTime,
  requireAdmin,
} from '../../../lib/api';
import { buildHref, parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { FilterBar, FilterField } from '../../../components/filter-bar';
import {
  BalanceChange,
  LedgerActorCell,
  LedgerProviderCell,
  LedgerReasonCell,
  SignedCredits,
} from '../../../components/ledger-cells';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';
import { SectionCard } from '../../../components/section-card';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';

/**
 * The manual credit adjustments — the ledger, filtered to the two types an
 * operator writes by hand.
 *
 * ADMIN-DESIGN-001 Faz 3D (paket 2 `27-elle-kredi-ekle-dus`, prototip
 * `manual`). The design puts a "Yeni manuel işlem" form beside this list; K4
 * decided it stays where it is, on the provider's credit screen
 * (`/providers/[id]/credits`), which already carries the balance preview, the
 * no-negative guard, the integer bound and the confirmation for a deduction.
 * This screen therefore writes nothing. What it takes from the design is the
 * list, the ⓘ, and a way to *reach* that form: the "Yeni düzeltme" card below
 * is a pair of links, shown only to a session that holds one of the two write
 * permissions, and with a pinned business it goes straight to that business's
 * credit screen.
 *
 * Kept from the old screen: the search, the type filter (now saved views,
 * same `?type=` values), the date range, the `providerId` pin, the page size
 * of 50, and the audit note — every column the old table had.
 */

const PATH = '/finance/manual-adjustments';
const DEFAULT_PAGE_SIZE = 50;
const MANUAL_TYPES = ['ADMIN_GRANT', 'ADMIN_DEDUCT'] as const;

type ManualFilter = 'ALL' | 'ADMIN_GRANT' | 'ADMIN_DEDUCT';

/** The design's ⓘ, minus the promise that the form is on this screen. */
const SCREEN_INFO =
  'Sistemin kendi yapmadığı bir düzeltme elle yapılır: ödeme geçtiği hâlde kredi yüklenmemişse, kredi iki kez düşülmüşse ya da müşteriye bir söz verildiyse. Her işlem yapanın adıyla kaydedilir ve kredi hareketlerinde görünür; geri almak için ters yönde yeni bir işlem gerekir. Tekrar eden bir durum için kampanya yazmak daha doğrudur. Yeni işlem, işletmenin kredi ekranından yapılır.';

const TYPE_LABEL: Record<'ADMIN_GRANT' | 'ADMIN_DEDUCT', string> = {
  ADMIN_GRANT: 'Manuel Kredi Ekleme',
  ADMIN_DEDUCT: 'Manuel Kredi Düşme',
};

const COLUMNS: DataColumn[] = [
  { key: 'date', label: 'Tarih' },
  { key: 'provider', label: 'İşletme' },
  { key: 'type', label: 'İşlem' },
  { key: 'amount', label: 'Kredi', align: 'end' },
  { key: 'balance', label: 'Bakiye (önce → sonra)', align: 'end' },
  { key: 'reason', label: 'Sebep' },
  { key: 'actor', label: 'İşlemi yapan' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

type RawSearchParams = {
  q?: string;
  type?: string;
  providerId?: string;
  from?: string;
  to?: string;
  page?: string;
};

type AdminManualAdjustmentsPageProps = {
  searchParams: Promise<RawSearchParams>;
};

function normalizeTypeFilter(value: string | undefined): ManualFilter {
  if (value === 'ADMIN_GRANT' || value === 'ADMIN_DEDUCT') return value;
  return 'ALL';
}

function normalizeDate(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : '';
}

function formatRangeDateForApi(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const suffix = endOfDay ? 'T23:59:59.999+03:00' : 'T00:00:00.000+03:00';
  return `${value}${suffix}`;
}

function resolveApiTypeFilter(filter: ManualFilter): string {
  if (filter === 'ALL') return MANUAL_TYPES.join(',');
  return filter;
}

function buildApiQuery(params: {
  page: number;
  q: string;
  type: ManualFilter;
  providerId: string;
  from: string;
  to: string;
}) {
  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(params.page));
  apiQuery.set('pageSize', String(DEFAULT_PAGE_SIZE));
  apiQuery.set('type', resolveApiTypeFilter(params.type));
  if (params.q) apiQuery.set('q', params.q);
  if (params.providerId) apiQuery.set('providerId', params.providerId);
  const fromIso = formatRangeDateForApi(params.from, false);
  const toIso = formatRangeDateForApi(params.to, true);
  if (fromIso) apiQuery.set('from', fromIso);
  if (toIso) apiQuery.set('to', toIso);
  return apiQuery.toString();
}

export default async function AdminManualAdjustmentsPage({
  searchParams,
}: AdminManualAdjustmentsPageProps) {
  // The list is `/finance/credit-ledger` filtered to the two manual types, so
  // it needs the permission that route needs. FINANCE_READ used to open the
  // page and then the ledger read sent the session to /yetkisiz (F2).
  const { can } = await requireAdmin('FINANCE_LEDGER_READ');
  // Where a new adjustment is made: the credit screen, whose form shows only
  // the operations these grant (CREDITS_GRANT / CREDITS_DEDUCT). A session with
  // neither is not pointed at a form it will not see.
  const canAdjust = can('CREDITS_GRANT') || can('CREDITS_DEDUCT');
  const canFindProvider = can('FINANCE_READ');

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const type = normalizeTypeFilter(params.type);
  const providerId = (params.providerId ?? '').trim();
  const from = normalizeDate(params.from);
  const to = normalizeDate(params.to);
  const page = parsePage(params.page);

  const apiQuery = buildApiQuery({ page, q, type, providerId, from, to });
  const response = await apiFetch<CreditLedgerResponse>(`/finance/credit-ledger?${apiQuery}`);

  const hasFilters = Boolean(q || providerId || type !== 'ALL' || from || to);
  const typeParam = type === 'ALL' ? '' : type;
  const filterParams: QueryParams = { q, type: typeParam, providerId, from, to };
  const filteredProviderName = providerId ? (response.items[0]?.provider.businessName ?? null) : null;

  const views: TabItem[] = [
    { key: '', label: 'Tümü', testId: 'manual-view-all' },
    { key: 'ADMIN_GRANT', label: 'Ekleme', testId: 'manual-view-grant' },
    { key: 'ADMIN_DEDUCT', label: 'Düşme', testId: 'manual-view-deduct' },
  ];

  const summary =
    response.total === 0
      ? hasFilters
        ? 'Bu filtreyle elle yapılmış işlem yok'
        : 'Henüz elle kredi işlemi yapılmadı'
      : `${formatCount(response.total)} elle yapılmış işlem · en yeni başta`;

  return (
    <main className="finance-list-page">
      <PageHeader
        title="Elle kredi işlemleri"
        subtitle={summary}
        info={SCREEN_INFO}
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
              Tüm kredi hareketleri
            </Link>
            {can('FINANCE_READ') ? (
              <Link className="btn btn-secondary btn-sm" href="/finance">
                Finans özeti
              </Link>
            ) : null}
          </>
        }
      />

      <div className="manual-adjustments-cards">
        {canAdjust ? (
          <SectionCard
            title="Yeni düzeltme"
            subtitle="Kredi ekleme ve düşme bu ekranda yapılmaz; işletmenin kredi ekranında, bugünkü bakiye ve işlem sonrası bakiye görülerek yapılır."
          >
            <div className="inline-actions" data-testid="manual-new-adjustment">
              {providerId ? (
                <Link className="btn btn-primary btn-sm" href={`/providers/${providerId}/credits`}>
                  {filteredProviderName ? `${filteredProviderName} · kredi ekranı` : 'Bu işletmenin kredi ekranı'}
                </Link>
              ) : null}
              {canFindProvider ? (
                <Link
                  className={providerId ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                  href="/finance/providers"
                >
                  İşletme seç
                </Link>
              ) : null}
            </div>
            {!providerId && !canFindProvider ? (
              <p className="detail-muted-note">
                Listeden bir satırdaki işletme adına tıklayarak o işletmenin kredi ekranına gidebilirsiniz.
              </p>
            ) : null}
          </SectionCard>
        ) : null}

        <SectionCard title="Denetim notu" subtitle="Manuel işlemler nasıl tutulur?">
          <ul className="bullet-list">
            <li>Manuel kredi işlemleri silinemez denetim kaydı olarak tutulur.</li>
            <li>
              Her işlemde hizmet veren, kredi miktarı, sebep, önceki bakiye, sonraki bakiye ve işlemi yapan
              yönetici kaydedilir.
            </li>
            <li>Yanlış bir işlem silinmez; ters yönde yeni bir işlemle dengelenir.</li>
          </ul>
        </SectionCard>
      </div>

      {providerId ? (
        <div className="notice detail-notice" data-testid="manual-provider-pin">
          Belirli hizmet veren filtreleniyor
          {filteredProviderName ? (
            <>
              {' · '}
              <strong>{filteredProviderName}</strong>
            </>
          ) : null}{' '}
          (<code className="cell-break">{providerId}</code>).{' '}
          <Link href={`/providers/${providerId}/credits`}>İşletmenin kredi ekranı</Link>
          {' · '}
          <Link href={buildHref(PATH, filterParams, { providerId: undefined })}>Provider filtresini kaldır</Link>
        </div>
      ) : null}

      <SavedViewTabs
        label="Elle işlem görünümleri"
        items={views}
        active={typeParam}
        path={PATH}
        params={filterParams}
        param="type"
        testId="manual-views"
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        preserve={{ providerId, type: typeParam }}
        label="Elle işlem filtreleri"
        testId="manual-filters"
      >
        <FilterField label="Ara" htmlFor="manual-search" wide>
          <input
            id="manual-search"
            name="q"
            type="search"
            placeholder="İşletme, telefon, e-posta, sebep"
            defaultValue={q}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Başlangıç" htmlFor="manual-from">
          <input id="manual-from" name="from" type="date" defaultValue={from} autoComplete="off" />
        </FilterField>
        <FilterField label="Bitiş" htmlFor="manual-to">
          <input id="manual-to" name="to" type="date" defaultValue={to} autoComplete="off" />
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun manuel işlem bulunamadı.'
                : response.total > 0
                  ? 'Bu sayfada manuel işlem yok.'
                  : 'Henüz manuel kredi işlemi bulunmuyor.'
            }
            description={
              hasFilters
                ? 'Filtreleri daraltabilir veya temizleyebilirsiniz.'
                : 'Bir işletmenin kredi ekranından kredi eklendiğinde veya düşüldüğünde burada görünür.'
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
          <DataTable caption="Elle kredi işlemleri" columns={COLUMNS} minWidth={1080} testId="manual-table">
            {response.items.map((entry) => (
              <ManualRow key={entry.id} entry={entry} />
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
            noun="işlem"
            summaryTestId="manual-page-summary"
          />
        ) : null}
      </div>
    </main>
  );
}

function ManualRow({ entry }: { entry: CreditLedgerEntry }) {
  const isGrant = entry.type === 'ADMIN_GRANT';
  const isDeduct = entry.type === 'ADMIN_DEDUCT';
  const typeLabel =
    isGrant || isDeduct ? TYPE_LABEL[entry.type as 'ADMIN_GRANT' | 'ADMIN_DEDUCT'] : entry.type;
  const creditsHref = `/providers/${entry.provider.id}/credits`;

  return (
    <tr data-testid="manual-row" data-type={entry.type}>
      <td className="cell-nowrap">{formatDateTime(entry.createdAt)}</td>
      <td>
        <LedgerProviderCell provider={entry.provider} href={creditsHref} />
      </td>
      <td>
        <span className={isGrant ? 'badge badge-good' : isDeduct ? 'badge badge-bad' : 'badge badge-muted'}>
          {typeLabel}
        </span>
      </td>
      <td className="is-num">
        <SignedCredits amount={entry.amount} />
      </td>
      <td className="is-num">
        <BalanceChange before={entry.previousBalance} after={entry.balanceAfter} />
      </td>
      <td>
        <LedgerReasonCell reason={entry.reason} />
      </td>
      <td>
        <LedgerActorCell actor={entry.createdBy} />
      </td>
      <td className="col-actions">
        <Link
          className="btn btn-secondary btn-sm"
          href={creditsHref}
          aria-label={`Kredi ekranını aç: ${entry.provider.businessName}`}
        >
          Kredi ekranı
        </Link>
      </td>
    </tr>
  );
}
