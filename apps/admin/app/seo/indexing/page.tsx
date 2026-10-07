import Link from 'next/link';
import { apiFetch, requireAdmin } from '../../../lib/api';
import { buildHref, parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';
import {
  describeSeoReason,
  SEO_INDEX_REASON_CODES,
  SEO_PAGE_TYPE_HINTS,
  SEO_PAGE_TYPE_LABELS,
  SEO_PAGE_TYPES,
  seoPageAdminHref,
  seoReasonCodeLabel,
  type NonIndexablePage,
  type SeoPage,
  type SeoPageType,
} from '../../../lib/seo';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { FilterBar, FilterField } from '../../../components/filter-bar';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';

/**
 * İndekslenmeyen sayfalar (SEO-004 PR B), design `list:seoIndex` (paket 4
 * `39-seo-indekslenmeyen-sayfalar`).
 *
 * Every public page the index rule keeps out of search, with each failed rule
 * in Turkish and — where the rule compared numbers — the `required`/`actual`
 * the API returned with it. The filters are exactly what `GET /admin/seo/pages`
 * takes: page type, reason code and a text search. The design's Durum and
 * Tarih filters and "Excel'e aktar" are not drawn: every row here is closed by
 * definition, the API keeps no date for "became non-indexable", and there is
 * no export route.
 *
 * "Aç" goes to the record's own admin screen — where the missing text is
 * written — when the session may open it. The vitrin shelf is not a record and
 * has no screen, so it has no "Aç".
 */

const PATH = '/seo/indexing';
const PAGE_SIZE = 25;

const SCREEN_INFO =
  'Herkese açık olduğu hâlde arama motorlarına gösterilmeyen sayfalar. Her satırda hangi kuralın karşılanmadığı ve gerekiyorsa ne kadar içerik eksik olduğu yazar. Eksik içerik tamamlandığında sayfa kendiliğinden aramaya açılır; bu listeden bir sayfayı elle açmak mümkün değildir. Karakter sayımına yalnız harf ve rakam girer.';

const COLUMNS: DataColumn[] = [
  { key: 'page', label: 'Sayfa' },
  { key: 'type', label: 'Sayfa türü' },
  { key: 'path', label: 'Adres' },
  { key: 'reason', label: 'Neden kapalı' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

type IndexingPageProps = {
  searchParams: Promise<{ type?: string; reason?: string; q?: string; page?: string }>;
};

export default async function SeoIndexingPage({ searchParams }: IndexingPageProps) {
  const { can } = await requireAdmin('SEO_READ');
  const raw = await searchParams;
  // Only values the API accepts are sent: a stale or hand-typed filter falls
  // back to "Tümü" instead of a 400.
  const type = (SEO_PAGE_TYPES as readonly string[]).includes(raw.type ?? '') ? (raw.type as SeoPageType) : '';
  const reason = (SEO_INDEX_REASON_CODES as readonly string[]).includes(raw.reason ?? '') ? raw.reason! : '';
  const q = (raw.q ?? '').trim().slice(0, 100);
  const page = parsePage(raw.page);

  const filterParams: QueryParams = { type, reason, q };
  const result = await apiFetch<SeoPage<NonIndexablePage>>(
    `/admin/seo/pages${buildHref('', { ...filterParams, page, pageSize: PAGE_SIZE })}`,
  );
  const hasFilters = Boolean(type || reason || q);

  return (
    <main className="seo-page" data-testid="seo-indexing">
      <PageHeader
        title="İndekslenmeyen sayfalar"
        subtitle={
          hasFilters
            ? `Filtreye uyan ${formatCount(result.total)} sayfa`
            : result.total === 0
              ? 'Aramaya kapalı herkese açık sayfa yok'
              : `${formatCount(result.total)} herkese açık sayfa arama motorlarına kapalı`
        }
        info={SCREEN_INFO}
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="İndekslenmeyen sayfa filtreleri"
        testId="seo-indexing-filters"
      >
        <FilterField label="Ara" htmlFor="seo-indexing-q" wide>
          <input id="seo-indexing-q" name="q" type="search" defaultValue={q} maxLength={100} placeholder="Sayfa adı veya adres" />
        </FilterField>
        <FilterField label="Sayfa türü" htmlFor="seo-indexing-type">
          <select id="seo-indexing-type" name="type" defaultValue={type}>
            <option value="">Tümü</option>
            {SEO_PAGE_TYPES.map((value) => (
              <option key={value} value={value}>
                {SEO_PAGE_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Neden" htmlFor="seo-indexing-reason">
          <select id="seo-indexing-reason" name="reason" defaultValue={reason}>
            <option value="">Tümü</option>
            {SEO_INDEX_REASON_CODES.filter((code) => code !== 'INPUT_UNRECOGNIZED').map((code) => (
              <option key={code} value={code}>
                {seoReasonCodeLabel(code)}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {result.items.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'Filtreye uyan sayfa yok' : 'Aramaya kapalı sayfa yok'}
            description={
              hasFilters
                ? 'Filtreleri değiştirin veya temizleyin.'
                : 'Herkese açık her sayfa arama motoru kurallarını karşılıyor.'
            }
          />
        ) : (
          <DataTable caption="İndekslenmeyen sayfalar" columns={COLUMNS} minWidth={1040} testId="seo-indexing-table">
            {result.items.map((row) => {
              const href = seoPageAdminHref(row, can);
              const nameId = `seo-page-${row.type}-${row.id}`;
              return (
                <tr key={`${row.type}:${row.id}`} data-testid="seo-indexing-row" data-page-type={row.type} data-page-id={row.id}>
                  <td>
                    <div className="cell-stack">
                      <strong className="cell-break" id={nameId}>
                        {row.label}
                      </strong>
                      <span className="cell-muted">{row.owner ?? SEO_PAGE_TYPE_HINTS[row.type]}</span>
                    </div>
                  </td>
                  <td>{SEO_PAGE_TYPE_LABELS[row.type] ?? row.type}</td>
                  <td>
                    <code className="cell-break">{row.path}</code>
                  </td>
                  <td>
                    <ul className="seo-reason-list" data-testid="seo-indexing-reasons">
                      {row.reasons.map((item, index) => {
                        const text = describeSeoReason(item);
                        return (
                          <li key={`${item.code}-${item.block ?? ''}-${index}`} data-reason={item.code}>
                            <span>{text.title}</span>
                            {text.detail ? <span className="cell-muted">{text.detail}</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </td>
                  <td>
                    <span className="badge badge-warn">Aramaya kapalı</span>
                  </td>
                  <td className="col-actions">
                    {href ? (
                      <Link
                        className="btn btn-secondary btn-sm"
                        href={href}
                        aria-describedby={nameId}
                        data-testid="seo-indexing-open"
                      >
                        Aç
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {result.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hasNextPage={result.hasNextPage}
            noun="sayfa"
            summaryTestId="seo-indexing-count"
          />
        ) : null}
      </div>
    </main>
  );
}
