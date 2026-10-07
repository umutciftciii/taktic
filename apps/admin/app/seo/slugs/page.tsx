import Link from 'next/link';
import { ApiError, apiFetch, formatDate, requireAdmin } from '../../../lib/api';
import { buildHref, parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';
import type { CategorySeoContent, SeoPage, SeoSlugRow } from '../../../lib/seo';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { FilterBar, FilterField } from '../../../components/filter-bar';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';
import { RouteDialog } from '../../../components/route-dialog';
import { KIND_LABELS, STATUS_LABELS, statusBadgeClass } from '../../categories/category-taxonomy';
import { SlugChangeForm } from './slug-change-form';

/**
 * Adresler (SEO-004 PR B), design `slugs` (paket 4 `40-slug-yonetimi`) and its
 * window (`41-slug-degistir-penceresi`).
 *
 * Only categories: the category is the one record with a slug. A business is
 * `/isletme/<id>` and a vitrin card `/vitrin/<id>` — neither has an address an
 * operator could change, so neither gets a made-up row here. The design's
 * "30 günlük ziyaret" column and "son 30 günde N adres değişti" line are not
 * drawn: nothing counts visits.
 *
 * "Adresi değiştir" opens the window at `?kategori=<id>` — a deep link, so the
 * category's own screen can send the operator here — and is offered with
 * CATEGORIES_WRITE, the permission the API's slug route asks for (a slug is a
 * category edit; its 301 is that edit's consequence).
 */

const PATH = '/seo/slugs';
const PAGE_SIZE = 25;

const SCREEN_INFO =
  'Hizmet kategorilerinin site adresleri. Adres yalnız buradan değiştirilir. Herkese açık bir kategorinin adresi değiştiğinde eski adres aynı kayıtta yeni adrese kalıcı (301) yönlendirilir; bu yönlendirme kapatılamaz. Herkese açık olmayan kategoride yönlendirme oluşturulmaz. İşletme ve vitrin kartı adresleri kayıt numarasıyla oluşur ve değiştirilemez.';

const COLUMNS: DataColumn[] = [
  { key: 'category', label: 'Kategori' },
  { key: 'path', label: 'Şu anki adres' },
  { key: 'status', label: 'Durum' },
  { key: 'changed', label: 'Son adres değişikliği' },
  { key: 'previous', label: 'Eski adres' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

type SlugsPageProps = {
  searchParams: Promise<{
    q?: string;
    page?: string;
    kategori?: string;
    /** `kategori`: opened from the category's own screen — Vazgeç and success go back there. */
    geri?: string;
    adres?: string;
    yonlendirme?: string;
  }>;
};

export default async function SeoSlugsPage({ searchParams }: SlugsPageProps) {
  const { can } = await requireAdmin('SEO_READ');
  const canChange = can('CATEGORIES_WRITE');
  const raw = await searchParams;
  const q = (raw.q ?? '').trim().slice(0, 100);
  const page = parsePage(raw.page);
  const filterParams: QueryParams = { q };

  const result = await apiFetch<SeoPage<SeoSlugRow>>(
    `/admin/seo/slugs${buildHref('', { ...filterParams, page, pageSize: PAGE_SIZE })}`,
  );

  // The window: the category it changes, read on its own so a deep link works
  // whatever page of the list it lands on.
  const openId = canChange ? (raw.kategori ?? '').trim() : '';
  const opened = openId ? await readCategory(openId) : null;
  const listHref = buildHref(PATH, { ...filterParams, page: page > 1 ? page : undefined });
  const fromCategory = raw.geri === 'kategori' && opened !== null;
  const closeHref = fromCategory && opened ? `/categories/${encodeURIComponent(opened.slug)}` : listHref;

  const changedTo = raw.adres && raw.adres.startsWith('/categories/') ? raw.adres : null;

  return (
    <main className="seo-page" data-testid="seo-slugs">
      <PageHeader
        title="Adresler"
        subtitle={q ? `Aramaya uyan ${formatCount(result.total)} kategori` : `${formatCount(result.total)} kategori adresi`}
        info={SCREEN_INFO}
      />

      {changedTo ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="seo-slug-done">
          Adres değiştirildi: <code>{changedTo}</code>.{' '}
          {raw.yonlendirme === '1'
            ? 'Eski adres kalıcı (301) olarak yeni adrese yönlendiriliyor.'
            : 'Kategori herkese açık olmadığı için yönlendirme oluşturulmadı.'}
        </div>
      ) : null}
      {openId && !opened ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="seo-slug-missing">
          Bu bağlantının gösterdiği kategori bulunamadı.
        </div>
      ) : null}

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={q ? PATH : null}
        label="Adres filtreleri"
        testId="seo-slug-filters"
      >
        <FilterField label="Ara" htmlFor="seo-slug-q" wide>
          <input id="seo-slug-q" name="q" type="search" defaultValue={q} maxLength={100} placeholder="Kategori adı veya adres" />
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {result.items.length === 0 ? (
          <EmptyState
            title={q ? 'Aramaya uyan kategori yok' : 'Kategori yok'}
            description={q ? 'Aramayı değiştirin veya temizleyin.' : 'Henüz bir hizmet kategorisi tanımlanmadı.'}
          />
        ) : (
          <DataTable caption="Kategori adresleri" columns={COLUMNS} minWidth={980} testId="seo-slug-table">
            {result.items.map((row) => {
              const nameId = `seo-slug-name-${row.id}`;
              return (
                <tr key={row.id} data-testid="seo-slug-row" data-category-id={row.id}>
                  <td>
                    <div className="cell-stack">
                      <strong className="cell-break" id={nameId}>
                        {row.name}
                      </strong>
                      <span className="cell-muted">{KIND_LABELS[row.kind as keyof typeof KIND_LABELS] ?? row.kind}</span>
                    </div>
                  </td>
                  <td>
                    <code className="cell-break" data-testid="seo-slug-path">
                      {row.path}
                    </code>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className={statusBadgeClass(row.status as never)}>
                        {STATUS_LABELS[row.status as keyof typeof STATUS_LABELS] ?? row.status}
                      </span>
                      <span className="cell-muted">{row.publiclyReachable ? 'Herkese açık' : 'Herkese kapalı'}</span>
                    </div>
                  </td>
                  <td>{row.lastSlugChangeAt ? formatDate(row.lastSlugChangeAt) : <span className="cell-muted">Değişmedi</span>}</td>
                  <td>
                    {row.previousAddressCount > 0 ? (
                      <Link
                        className="badge badge-good"
                        href={`/seo/redirects?${new URLSearchParams({ q: row.path, origin: 'SLUG_CHANGE' }).toString()}`}
                        data-testid="seo-slug-previous"
                      >
                        {formatCount(row.previousAddressCount)} eski adres
                      </Link>
                    ) : (
                      <span className="badge badge-muted" data-testid="seo-slug-previous">
                        Yok
                      </span>
                    )}
                  </td>
                  <td className="col-actions">
                    {canChange ? (
                      <Link
                        className="btn btn-secondary btn-sm"
                        href={buildHref(PATH, { ...filterParams, page: page > 1 ? page : undefined, kategori: row.id })}
                        scroll={false}
                        aria-describedby={nameId}
                        data-testid="seo-slug-change"
                      >
                        Adresi değiştir
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
            noun="kategori"
            summaryTestId="seo-slug-count"
          />
        ) : null}
      </div>

      {opened ? (
        <RouteDialog title={`Adresi değiştir: ${opened.name}`} closeHref={closeHref} testId="seo-slug-dialog">
          <SlugChangeForm
            categoryId={opened.id}
            categoryName={opened.name}
            currentSlug={opened.slug}
            publiclyReachable={opened.publiclyReachable}
            cancelHref={closeHref}
            returnTo={fromCategory ? 'category' : 'list'}
          />
        </RouteDialog>
      ) : null}
    </main>
  );
}

/** The category the window changes, or null when the id names none. */
async function readCategory(id: string): Promise<CategorySeoContent | null> {
  try {
    return await apiFetch<CategorySeoContent>(`/admin/seo/categories/${encodeURIComponent(id)}/content`);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}
