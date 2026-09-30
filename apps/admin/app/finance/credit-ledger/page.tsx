import Link from 'next/link';
import {
  apiFetch,
  CreditLedgerEntry,
  CreditLedgerResponse,
  CREDIT_TRANSACTION_TYPES,
  CreditTransactionType,
  creditTxnTypeLabel,
  formatDateTime,
  requireAdmin,
} from '../../../lib/api';
import { formatLedgerSource, gateLedgerSource } from '../../../lib/finance-format';
import { buildHref, parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { FilterBar, FilterField } from '../../../components/filter-bar';
import {
  LedgerActorCell,
  LedgerProviderCell,
  LedgerReasonCell,
  LedgerSourceCell,
  SignedCredits,
} from '../../../components/ledger-cells';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';

/**
 * Every credit movement on the platform, newest first.
 *
 * ADMIN-DESIGN-001 Faz 3D (paket 2 `26-kredi-hareketleri`, prototip
 * `list:ledger`): the design's list template — header with ⓘ, the shared
 * filter bar, the shared table in its own scroll box, the shared page footer.
 * Everything the screen did before is still here: the nine movement types
 * (three of them campaign movements), the search, the date range, the
 * `providerId` pin a balance row links to, the page size of 50, and the related
 * record of a campaign row linking to that campaign.
 *
 * Kept from the old screen beyond the design's seven columns: the reason with
 * its operator note and who wrote the row — the ledger is an audit trail, and
 * those two are what makes it one.
 *
 * Not rendered: "Excel'e aktar" (no export exists) and the design's "Bu ay
 * 3.140 kredi harcandı" line (the ledger read carries no period totals; the
 * finance summary does, behind its own permission).
 */

const PATH = '/finance/credit-ledger';
const DEFAULT_PAGE_SIZE = 50;

/** The design's ⓘ, fitted to this ledger: campaigns are a fourth source, and refunds are not only complaints. */
const SCREEN_INFO =
  'Platformdaki her kredi hareketinin kaydı: paket satın alımı, teklif harcaması, teklif iadesi, kampanya kredisi ve yönetici düzeltmeleri. Bu liste değiştirilemez — yanlış bir işlem silinmez, ters yönde yeni bir işlemle dengelenir.';

const TYPE_LABELS: Record<CreditTransactionType, string> = {
  PACKAGE_PURCHASE: 'Paket Alımı',
  OFFER_SPEND: 'Teklif Harcaması',
  OFFER_REFUND: 'Teklif İadesi',
  ADMIN_GRANT: 'Manuel Kredi Ekleme',
  ADMIN_DEDUCT: 'Manuel Kredi Düşme',
  ADJUSTMENT: 'Sistem Düzeltmesi',
  // CMP-004 S4: the three campaign movements — a grant is credit in (green),
  // an expiry is credit leaving by the calendar (neutral), a revoke is credit
  // taken back (red).
  CAMPAIGN_GRANT: 'Promosyon Kredisi',
  CAMPAIGN_EXPIRE: 'Promosyon Süresi Doldu',
  CAMPAIGN_REVOKE: 'Promosyon Geri Alındı',
};

const TYPE_BADGE_CLASS: Record<CreditTransactionType, string> = {
  PACKAGE_PURCHASE: 'badge badge-good',
  OFFER_SPEND: 'badge badge-muted',
  OFFER_REFUND: 'badge badge-warn',
  ADMIN_GRANT: 'badge badge-good',
  ADMIN_DEDUCT: 'badge badge-bad',
  ADJUSTMENT: 'badge badge-muted',
  CAMPAIGN_GRANT: 'badge badge-good',
  CAMPAIGN_EXPIRE: 'badge badge-muted',
  CAMPAIGN_REVOKE: 'badge badge-bad',
};

const COLUMNS: DataColumn[] = [
  { key: 'date', label: 'Tarih' },
  { key: 'provider', label: 'İşletme' },
  { key: 'type', label: 'Ne oldu' },
  { key: 'source', label: 'İlgili kayıt' },
  { key: 'before', label: 'Önceki bakiye', align: 'end' },
  { key: 'amount', label: 'Değişim', align: 'end' },
  { key: 'after', label: 'Sonraki bakiye', align: 'end' },
  { key: 'reason', label: 'Sebep' },
  { key: 'actor', label: 'İşlemi yapan' },
];

type RawSearchParams = {
  q?: string;
  type?: string;
  providerId?: string;
  from?: string;
  to?: string;
  page?: string;
};

type AdminCreditLedgerPageProps = {
  searchParams: Promise<RawSearchParams>;
};

function normalizeType(value: string | undefined): CreditTransactionType | '' {
  if (!value) return '';
  const upper = value.toUpperCase();
  return (CREDIT_TRANSACTION_TYPES as string[]).includes(upper)
    ? (upper as CreditTransactionType)
    : '';
}

function normalizeDate(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : '';
}

function formatRangeDateForApi(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  // Date input gives YYYY-MM-DD. Treat as Europe/Istanbul (UTC+3) civil day so
  // the operator's "today" matches what they see on the dashboard.
  const suffix = endOfDay ? 'T23:59:59.999+03:00' : 'T00:00:00.000+03:00';
  return `${value}${suffix}`;
}

function buildApiQuery(params: {
  page: number;
  q: string;
  type: CreditTransactionType | '';
  providerId: string;
  from: string;
  to: string;
}) {
  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(params.page));
  apiQuery.set('pageSize', String(DEFAULT_PAGE_SIZE));
  if (params.q) apiQuery.set('q', params.q);
  if (params.type) apiQuery.set('type', params.type);
  if (params.providerId) apiQuery.set('providerId', params.providerId);
  const fromIso = formatRangeDateForApi(params.from, false);
  const toIso = formatRangeDateForApi(params.to, true);
  if (fromIso) apiQuery.set('from', fromIso);
  if (toIso) apiQuery.set('to', toIso);
  return apiQuery.toString();
}

export default async function AdminCreditLedgerPage({ searchParams }: AdminCreditLedgerPageProps) {
  const { can } = await requireAdmin('FINANCE_LEDGER_READ');

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const type = normalizeType(params.type);
  const providerId = (params.providerId ?? '').trim();
  const from = normalizeDate(params.from);
  const to = normalizeDate(params.to);
  const page = parsePage(params.page);

  const apiQuery = buildApiQuery({ page, q, type, providerId, from, to });
  const response = await apiFetch<CreditLedgerResponse>(`/finance/credit-ledger?${apiQuery}`);

  const hasFilters = Boolean(q || type || providerId || from || to);
  const filterParams: QueryParams = { q, type, providerId, from, to };
  // The pin names the business when this page holds one of its rows.
  const pinnedName = providerId ? (response.items[0]?.provider.businessName ?? null) : null;

  const summary =
    response.total === 0
      ? hasFilters
        ? 'Bu filtreyle kredi hareketi yok'
        : 'Henüz kredi hareketi yok'
      : `${formatCount(response.total)} hareket · en yeni başta`;

  return (
    <main className="finance-list-page">
      <PageHeader
        title="Kredi hareketleri"
        subtitle={summary}
        info={SCREEN_INFO}
        actions={
          // The summary asks for FINANCE_READ, which the ledger's own
          // permission does not imply.
          can('FINANCE_READ') ? (
            <Link className="btn btn-secondary btn-sm" href="/finance">
              Finans özeti
            </Link>
          ) : undefined
        }
      />

      {providerId ? (
        <div className="notice detail-notice" data-testid="ledger-provider-pin">
          Yalnız bir işletmenin hareketleri gösteriliyor
          {pinnedName ? (
            <>
              : <strong>{pinnedName}</strong>
            </>
          ) : null}{' '}
          (<code className="cell-break">{providerId}</code>).{' '}
          <Link href={`/providers/${providerId}/credits`}>İşletmenin kredi ekranı</Link>
          {' · '}
          <Link href={buildHref(PATH, filterParams, { providerId: undefined })}>Tüm işletmeler</Link>
        </div>
      ) : null}

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        preserve={{ providerId }}
        label="Kredi hareketi filtreleri"
        testId="ledger-filters"
      >
        <FilterField label="Ara" htmlFor="ledger-search" wide>
          <input
            id="ledger-search"
            name="q"
            type="search"
            placeholder="İşletme, telefon, e-posta, sebep"
            defaultValue={q}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="İşlem tipi" htmlFor="ledger-type">
          <select id="ledger-type" name="type" defaultValue={type}>
            <option value="">Tümü</option>
            {CREDIT_TRANSACTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Başlangıç" htmlFor="ledger-from">
          <input id="ledger-from" name="from" type="date" defaultValue={from} autoComplete="off" />
        </FilterField>
        <FilterField label="Bitiş" htmlFor="ledger-to">
          <input id="ledger-to" name="to" type="date" defaultValue={to} autoComplete="off" />
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun kredi hareketi bulunamadı.'
                : response.total > 0
                  ? 'Bu sayfada kredi hareketi yok.'
                  : 'Henüz kredi hareketi yok.'
            }
            description={
              hasFilters
                ? 'Filtreleri daraltabilir veya temizleyebilirsiniz.'
                : 'Paket ödendiğinde, teklif gönderildiğinde veya manuel işlem yapıldığında burada görünür.'
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
          <DataTable caption="Kredi hareketleri" columns={COLUMNS} minWidth={1180} testId="ledger-table">
            {response.items.map((entry) => (
              <LedgerRow key={entry.id} entry={entry} can={can} />
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
            noun="hareket"
            summaryTestId="ledger-page-summary"
          />
        ) : null}
      </div>
    </main>
  );
}

function LedgerRow({
  entry,
  can,
}: {
  entry: CreditLedgerEntry;
  can: (...names: string[]) => boolean;
}) {
  const source = gateLedgerSource(
    formatLedgerSource(entry.referenceType, entry.referenceId, entry.sourceNumber, entry.campaign),
    can,
  );

  return (
    <tr data-testid="ledger-row" data-type={entry.type}>
      <td className="cell-nowrap">{formatDateTime(entry.createdAt)}</td>
      <td>
        <LedgerProviderCell provider={entry.provider} href={`/providers/${entry.provider.id}/credits`} />
      </td>
      <td>
        <span className={TYPE_BADGE_CLASS[entry.type]}>{TYPE_LABELS[entry.type] ?? creditTxnTypeLabel(entry.type)}</span>
      </td>
      <td>
        <LedgerSourceCell source={source} />
      </td>
      <td className="is-num">{formatCount(entry.previousBalance)}</td>
      <td className="is-num">
        <SignedCredits amount={entry.amount} />
      </td>
      <td className="is-num">
        <strong>{formatCount(entry.balanceAfter)}</strong>
      </td>
      <td>
        <LedgerReasonCell reason={entry.reason} />
      </td>
      <td>
        <LedgerActorCell actor={entry.createdBy} />
      </td>
    </tr>
  );
}
