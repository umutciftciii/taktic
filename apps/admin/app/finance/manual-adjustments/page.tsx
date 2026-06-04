import Link from 'next/link';
import {
  apiFetch,
  CreditLedgerEntry,
  CreditLedgerResponse,
  formatDateTime,
  requireAdmin,
} from '../../../lib/api';
import { formatLedgerReason } from '../../../lib/finance-format';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

const DEFAULT_PAGE_SIZE = 50;
const MANUAL_TYPES = ['ADMIN_GRANT', 'ADMIN_DEDUCT'] as const;

type ManualFilter = 'ALL' | 'ADMIN_GRANT' | 'ADMIN_DEDUCT';

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

const TYPE_OPTIONS: Array<{ value: ManualFilter; label: string }> = [
  { value: 'ALL', label: 'Tümü' },
  { value: 'ADMIN_GRANT', label: 'Manuel Kredi Ekleme' },
  { value: 'ADMIN_DEDUCT', label: 'Manuel Kredi Düşme' },
];

const TYPE_LABEL: Record<'ADMIN_GRANT' | 'ADMIN_DEDUCT', string> = {
  ADMIN_GRANT: 'Manuel Kredi Ekleme',
  ADMIN_DEDUCT: 'Manuel Kredi Düşme',
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

function normalizePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function formatRangeDateForApi(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const suffix = endOfDay ? 'T23:59:59.999+03:00' : 'T00:00:00.000+03:00';
  return `${value}${suffix}`;
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
  return `/finance/manual-adjustments${buildQueryString(params)}`;
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
  await requireAdmin();

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const type = normalizeTypeFilter(params.type);
  const providerId = (params.providerId ?? '').trim();
  const from = normalizeDate(params.from);
  const to = normalizeDate(params.to);
  const page = normalizePage(params.page);

  const apiQuery = buildApiQuery({ page, q, type, providerId, from, to });
  const response = await apiFetch<CreditLedgerResponse>(`/finance/credit-ledger?${apiQuery}`);

  const hasFilters = Boolean(q || providerId || (type !== 'ALL') || from || to);
  const baseParams = {
    q,
    type: type === 'ALL' ? '' : type,
    providerId,
    from,
    to,
  };
  const filteredProviderName = providerId
    ? (response.items[0]?.provider.businessName ?? null)
    : null;

  const startIndex = response.total === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const endIndex = Math.min(response.page * response.pageSize, response.total);

  return (
    <main>
      <PageHeader
        title="Manuel Kredi İşlemleri"
        subtitle="Admin tarafından yapılan kredi ekleme ve kredi düşme işlemleri."
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
              Tüm Kredi Hareketleri
            </Link>
            <Link className="btn btn-ghost btn-sm" href="/finance">
              Finans Dashboard
            </Link>
          </>
        }
      />

      <SectionCard title="Audit notu" subtitle="Manuel işlemler nasıl tutulur?">
        <ul className="bullet-list" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Manuel kredi işlemleri silinemez audit kaydı olarak tutulur.</li>
          <li>
            Her işlemde hizmet veren, kredi miktarı, sebep, önceki bakiye, sonraki bakiye ve
            işlemi yapan admin takip edilir.
          </li>
          <li>
            Yeni işlem yapmak için ilgili hizmet verenin{' '}
            <Link href="/providers">kredi ekranına</Link> gidilmelidir.
          </li>
        </ul>
      </SectionCard>

      {providerId ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          Belirli hizmet veren filtreleniyor
          {filteredProviderName ? <> · <strong>{filteredProviderName}</strong></> : null} (
          <code>{providerId}</code>).{' '}
          <Link href={`/providers/${providerId}/credits`}>Provider kredi sayfası</Link>
          {' · '}
          <Link href="/finance/manual-adjustments">Provider filtresini kaldır</Link>
        </div>
      ) : null}

      <form className="admin-toolbar" method="get" action="/finance/manual-adjustments">
        {providerId ? <input type="hidden" name="providerId" value={providerId} /> : null}
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="manual-search">Ara</label>
          <input
            id="manual-search"
            name="q"
            type="search"
            placeholder="İşletme, telefon, e-posta, sebep"
            defaultValue={q}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="manual-type">İşlem tipi</label>
          <select id="manual-type" name="type" defaultValue={type}>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="manual-from">Başlangıç</label>
          <input
            id="manual-from"
            name="from"
            type="date"
            defaultValue={from}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="manual-to">Bitiş</label>
          <input
            id="manual-to"
            name="to"
            type="date"
            defaultValue={to}
            autoComplete="off"
          />
        </div>
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
            <Link className="btn btn-ghost btn-sm" href="/finance/manual-adjustments">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      <SectionCard
        title="Manuel işlem listesi"
        subtitle={`Sayfa ${response.page} · ${response.pageSize} kayıt/sayfa`}
        padded={false}
      >
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun manuel işlem bulunamadı.'
                : 'Henüz manuel kredi işlemi bulunmuyor.'
            }
            description={
              hasFilters
                ? 'Filtreleri daraltabilir veya temizleyebilirsiniz.'
                : 'Provider kredi ekranından kredi eklendiğinde veya düşüldüğünde burada görünür.'
            }
            action={
              hasFilters ? (
                <Link className="btn btn-secondary btn-sm" href="/finance/manual-adjustments">
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
                  <th>İşlem</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Önceki Bakiye</th>
                  <th className="col-num">Sonraki Bakiye</th>
                  <th>Sebep</th>
                  <th>İşlemi Yapan</th>
                  <th className="col-actions">Aksiyon</th>
                </tr>
              </thead>
              <tbody>
                {response.items.map((entry) => (
                  <ManualRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {response.total > response.pageSize ? (
        <nav className="inline-actions" style={{ marginTop: 16, justifyContent: 'space-between' }}>
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

function ManualRow({ entry }: { entry: CreditLedgerEntry }) {
  const isGrant = entry.type === 'ADMIN_GRANT';
  const isDeduct = entry.type === 'ADMIN_DEDUCT';
  const typeLabel =
    isGrant || isDeduct ? TYPE_LABEL[entry.type as 'ADMIN_GRANT' | 'ADMIN_DEDUCT'] : entry.type;
  const amountClass = isGrant
    ? 'badge badge-good'
    : isDeduct
      ? 'badge badge-bad'
      : 'badge badge-muted';
  const amountText = entry.amount > 0 ? `+${entry.amount}` : String(entry.amount);

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
        <span className={isGrant ? 'badge badge-good' : isDeduct ? 'badge badge-bad' : 'badge badge-muted'}>
          {typeLabel}
        </span>
      </td>
      <td className="col-num">
        <span className={amountClass}>{amountText}</span>
      </td>
      <td className="col-num">{entry.previousBalance}</td>
      <td className="col-num">
        <strong>{entry.balanceAfter}</strong>
      </td>
      <td>
        {(() => {
          const reason = formatLedgerReason(entry.reason);
          if (!reason) return <span className="cell-muted">-</span>;
          return (
            <div className="cell-stack">
              <span>{reason.label}</span>
              {reason.note ? (
                <span className="cell-muted" style={{ fontSize: 12 }}>
                  Not: {reason.note}
                </span>
              ) : null}
            </div>
          );
        })()}
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
      <td className="col-actions">
        <Link className="btn btn-secondary btn-sm" href={`/providers/${entry.provider.id}/credits`}>
          Provider Kredi Ekranı
        </Link>
      </td>
    </tr>
  );
}
