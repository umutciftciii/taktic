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
import { formatLedgerReason, formatLedgerSource } from '../../../lib/finance-format';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

const DEFAULT_PAGE_SIZE = 50;

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

const TYPE_LABELS: Record<CreditTransactionType, string> = {
  PACKAGE_PURCHASE: 'Paket Alımı',
  OFFER_SPEND: 'Teklif Harcaması',
  OFFER_REFUND: 'Teklif İadesi',
  ADMIN_GRANT: 'Manuel Kredi Ekleme',
  ADMIN_DEDUCT: 'Manuel Kredi Düşme',
  ADJUSTMENT: 'Sistem Düzeltmesi',
};

const TYPE_BADGE_CLASS: Record<CreditTransactionType, string> = {
  PACKAGE_PURCHASE: 'badge badge-good',
  OFFER_SPEND: 'badge badge-muted',
  OFFER_REFUND: 'badge badge-warn',
  ADMIN_GRANT: 'badge badge-good',
  ADMIN_DEDUCT: 'badge badge-bad',
  ADJUSTMENT: 'badge badge-muted',
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
  return `/finance/credit-ledger${buildQueryString(params)}`;
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
  await requireAdmin();

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const type = normalizeType(params.type);
  const providerId = (params.providerId ?? '').trim();
  const from = normalizeDate(params.from);
  const to = normalizeDate(params.to);
  const page = normalizePage(params.page);

  const apiQuery = buildApiQuery({ page, q, type, providerId, from, to });
  const response = await apiFetch<CreditLedgerResponse>(`/finance/credit-ledger?${apiQuery}`);

  const hasFilters = Boolean(q || type || providerId || from || to);
  const baseParams = { q, type, providerId, from, to };

  const startIndex = response.total === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const endIndex = Math.min(response.page * response.pageSize, response.total);

  return (
    <main>
      <PageHeader
        title="Kredi Hareketleri"
        subtitle="Hizmet verenlerin tüm kredi giriş, çıkış ve iade hareketleri."
        actions={
          <Link className="btn btn-ghost btn-sm" href="/finance">
            Finans Dashboard
          </Link>
        }
      />

      <form className="admin-toolbar" method="get" action="/finance/credit-ledger">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="ledger-search">Ara</label>
          <input
            id="ledger-search"
            name="q"
            type="search"
            placeholder="İşletme, telefon, e-posta, sebep"
            defaultValue={q}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="ledger-type">İşlem tipi</label>
          <select id="ledger-type" name="type" defaultValue={type}>
            <option value="">Tümü</option>
            {CREDIT_TRANSACTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="ledger-from">Başlangıç</label>
          <input
            id="ledger-from"
            name="from"
            type="date"
            defaultValue={from}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="ledger-to">Bitiş</label>
          <input
            id="ledger-to"
            name="to"
            type="date"
            defaultValue={to}
            autoComplete="off"
          />
        </div>
        {providerId ? <input type="hidden" name="providerId" value={providerId} /> : null}
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {response.total === 0
              ? '0 kayıt'
              : `${startIndex}-${endIndex} / ${response.total} kayıt`}
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/finance/credit-ledger">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      {providerId ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          Provider filtresi aktif (<code>{providerId}</code>).{' '}
          <Link href={`/providers/${providerId}/credits`}>Provider kredi sayfası</Link>
        </div>
      ) : null}

      <SectionCard
        title="Kredi hareket listesi"
        subtitle={`Sayfa ${response.page} · ${response.pageSize} kayıt/sayfa`}
        padded={false}
      >
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun kredi hareketi bulunamadı.'
                : 'Henüz kredi hareketi yok.'
            }
            description={
              hasFilters
                ? 'Filtreleri daraltabilir veya temizleyebilirsiniz.'
                : 'Paket ödendiğinde, teklif gönderildiğinde veya manuel işlem yapıldığında burada görünür.'
            }
            action={
              hasFilters ? (
                <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
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
                  <th>Tarih</th>
                  <th>Hizmet Veren</th>
                  <th>Tip</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Önceki Bakiye</th>
                  <th className="col-num">Sonraki Bakiye</th>
                  <th>Sebep</th>
                  <th>İlişkili Kayıt</th>
                  <th>İşlemi Yapan</th>
                </tr>
              </thead>
              <tbody>
                {response.items.map((entry) => (
                  <LedgerRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {response.total > response.pageSize ? (
        <nav className="inline-actions" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          {response.page > 1 ? (
            <Link className="btn btn-secondary btn-sm" href={buildPageHref(baseParams, response.page - 1)}>
              ← Önceki
            </Link>
          ) : (
            <span />
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            Sayfa {response.page}
          </span>
          {response.hasNextPage ? (
            <Link className="btn btn-secondary btn-sm" href={buildPageHref(baseParams, response.page + 1)}>
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

function LedgerRow({ entry }: { entry: CreditLedgerEntry }) {
  const amountClass = entry.amount > 0 ? 'badge badge-good' : entry.amount < 0 ? 'badge badge-bad' : 'badge badge-muted';
  const amountText = entry.amount > 0 ? `+${entry.amount}` : String(entry.amount);
  const reason = formatLedgerReason(entry.reason);
  const source = formatLedgerSource(entry.referenceType, entry.referenceId);

  return (
    <tr>
      <td>{formatDateTime(entry.createdAt)}</td>
      <td>
        <div className="cell-stack">
          <Link href={`/providers/${entry.provider.id}/credits`}>
            <strong>{entry.provider.businessName}</strong>
          </Link>
          {entry.provider.phone || entry.provider.email ? (
            <span className="cell-muted">
              {entry.provider.phone}
              {entry.provider.phone && entry.provider.email ? ' · ' : ''}
              {entry.provider.email ?? ''}
            </span>
          ) : null}
        </div>
      </td>
      <td>
        <span className={TYPE_BADGE_CLASS[entry.type]}>{TYPE_LABELS[entry.type] ?? creditTxnTypeLabel(entry.type)}</span>
      </td>
      <td className="col-num">
        <span className={amountClass}>{amountText}</span>
      </td>
      <td className="col-num">{entry.previousBalance}</td>
      <td className="col-num">
        <strong>{entry.balanceAfter}</strong>
      </td>
      <td>
        {reason ? (
          <div className="cell-stack">
            <span>{reason.label}</span>
            {reason.note ? (
              <span className="cell-muted" style={{ fontSize: 12 }}>
                Not: {reason.note}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="cell-muted">-</span>
        )}
      </td>
      <td>
        {source.isSystem ? (
          <span className="cell-muted">{source.label}</span>
        ) : source.href ? (
          <Link href={source.href}>
            <span className="cell-stack">
              <span>{source.label}</span>
              {source.shortId ? (
                <span className="cell-muted" style={{ fontSize: 11 }}>
                  Kısa ID: {source.shortId}
                </span>
              ) : null}
            </span>
          </Link>
        ) : (
          <div className="cell-stack">
            <span>{source.label}</span>
            {source.shortId ? (
              <span className="cell-muted" style={{ fontSize: 11 }}>
                Kısa ID: {source.shortId}
              </span>
            ) : null}
          </div>
        )}
      </td>
      <td>
        {entry.createdBy ? (
          <div className="cell-stack">
            <span>{entry.createdBy.name ?? entry.createdBy.email ?? entry.createdBy.id}</span>
            {entry.createdBy.email && entry.createdBy.name ? (
              <span className="cell-muted" style={{ fontSize: 11 }}>
                {entry.createdBy.email}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="cell-muted">Sistem</span>
        )}
      </td>
    </tr>
  );
}
