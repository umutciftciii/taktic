import Link from 'next/link';
import { apiFetch, Category, CategoryStatus, requireAdmin } from '../../lib/api';
import { buildHref } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { WholeListFooter } from '../../components/pagination';
import {
  draftServices,
  KIND_LABELS,
  RELEASE_BLOCKER_HINTS,
  RELEASE_BLOCKER_LABELS,
  enrollmentSentence,
  releaseBlockers,
  SUPPLY_STATUS_LABELS,
  supplyStatusBadgeClass,
  STATUS_LABELS,
  statusBadgeClass,
  toTreeRows,
} from './category-taxonomy';
import { CATEGORIES_SCREEN_INFO, TreeReadiness, treeRowContext } from './category-list-cells';

/**
 * Hizmet kategorileri (#38), design `list:categories` (paket 2
 * `35-hizmet-kategorileri`, ADMIN-DESIGN-001 Faz 3F).
 *
 * The design's list template — title with its ⓘ and one-line summary, the
 * filter bar, the table with "Aç" and the footer — with the two things the
 * design's flat table would have lost kept in place (K7):
 *
 * - The tree. Children follow their parent, indented by depth, and a filtered
 *   list is a filtered tree: a row whose parent was filtered out stays, as a
 *   root. The design's "Kombi servisi · Isıtma ve soğutma altında" line is the
 *   parent's name under the child's; a group says how many categories hang
 *   under it (`_count.children`).
 * - The release checklist over the draft services, above the tree and
 *   independent of its filters, with every column it had.
 *
 * "Yayına hazır mı?" is the design's column, filled with the same three rules
 * the checklist and the detail screen use (`releaseBlockers`). It is advice:
 * the API does not refuse a status change on its account.
 *
 * Kept beyond the design's columns: the card image, the status, the sort
 * order. Not drawn: its Tarih filter (a category has no date the list could
 * filter on) and Önceki / Sonraki (the API returns the catalogue whole).
 */

const PATH = '/categories';

type StatusFilter = '' | CategoryStatus;

type AdminCategoriesPageProps = {
  searchParams: Promise<{ q?: string; status?: string }>;
};

function normalizeStatus(value: string | undefined): StatusFilter {
  if (value === 'DRAFT' || value === 'ACTIVE' || value === 'INACTIVE') return value;
  // `active` / `inactive` are what the pre-taxonomy links carried; a bookmarked
  // filter should keep meaning what it meant.
  if (value === 'active') return 'ACTIVE';
  if (value === 'inactive') return 'INACTIVE';
  return '';
}

const RELEASE_COLUMNS: DataColumn[] = [
  { key: 'service', label: 'Hizmet' },
  { key: 'parent', label: 'Üst grup' },
  { key: 'questions', label: 'Soru', align: 'end' },
  { key: 'price', label: 'Teklif kredisi', align: 'end' },
  { key: 'providers', label: 'Onaylı hizmet veren', align: 'end' },
  { key: 'invites', label: 'Geçerli davet', align: 'end' },
  { key: 'supply', label: 'Arz durumu' },
  { key: 'ready', label: 'Yayına hazır mı?' },
];

const TREE_COLUMNS: DataColumn[] = [
  { key: 'thumb', label: 'Görsel', srOnly: true },
  { key: 'name', label: 'Kategori adı' },
  { key: 'slug', label: 'Kısa ad' },
  { key: 'kind', label: 'Tip' },
  { key: 'status', label: 'Durum' },
  { key: 'price', label: 'Teklif kredisi', align: 'end' },
  { key: 'questions', label: 'Soru sayısı', align: 'end' },
  { key: 'providers', label: 'Onaylı hizmet veren', align: 'end' },
  { key: 'ready', label: 'Yayına hazır mı?' },
  { key: 'order', label: 'Sıra', align: 'end' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function AdminCategoriesPage({ searchParams }: AdminCategoriesPageProps) {
  const { can } = await requireAdmin('CATALOG_READ');
  // `/categories/new` gates on both; a link it would refuse is not offered.
  const canCreate = can('CATALOG_READ', 'CATEGORIES_WRITE');
  const { q: rawQuery, status: rawStatus } = await searchParams;
  const query = (rawQuery ?? '').trim();
  const status = normalizeStatus(rawStatus);

  // The operator's catalogue, from the route that exists for it. The public
  // endpoint no longer widens for anybody, by any query string.
  const categories = await apiFetch<Category[]>('/admin/categories');

  const normalizedQuery = query.toLocaleLowerCase('tr-TR');
  const filtered = categories.filter((category) => {
    if (status && category.status !== status) return false;
    if (!normalizedQuery) return true;
    const haystack = `${category.name} ${category.slug}`.toLocaleLowerCase('tr-TR');
    return haystack.includes(normalizedQuery);
  });

  // Children follow their parent, indented. The search and status filters run
  // first, so a filtered list is a filtered tree rather than a tree with holes.
  const rows = toTreeRows(filtered);

  const hasFilters = query.length > 0 || status !== '';
  const filterParams = { q: query, status };

  // Built from the whole catalogue rather than from `filtered`: this is a
  // standing list of what is waiting to be released, not a view of the table
  // below it. A status filter set to "Yayında" must not make the drafts that
  // still need work disappear.
  const drafts = draftServices(categories);
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const draftReadiness = drafts
    .map((category) => ({ category, blockers: releaseBlockers(category) }))
    .sort((a, b) => {
      // Ready first: those are the rows somebody can act on today.
      if (a.blockers.length !== b.blockers.length) return a.blockers.length - b.blockers.length;
      // Then the ones whose supply is already in place, so a release meeting
      // reads the rows waiting on a decision before the ones waiting on a
      // business to apply.
      const rank = (entry: { category: Category }) =>
        entry.category.supplyStatus === 'LAUNCH_READY' ? 0 : 1;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.category.name.localeCompare(b.category.name, 'tr-TR');
    });
  const readyCount = draftReadiness.filter((entry) => entry.blockers.length === 0).length;
  const liveCount = categories.filter((category) => category.status === 'ACTIVE').length;

  const newCategoryLink = canCreate ? (
    <Link className="btn btn-primary" href="/categories/new" data-testid="category-new-link">
      Yeni kategori ekle
    </Link>
  ) : undefined;

  return (
    <main className="catalog-page catalog-list-page">
      <PageHeader
        title="Hizmet kategorileri"
        subtitle={
          categories.length === 0
            ? 'Henüz kategori yok'
            : `${formatCount(categories.length)} kategori · ${formatCount(liveCount)} tanesi yayında`
        }
        info={CATEGORIES_SCREEN_INFO}
        actions={newCategoryLink}
      />

      {draftReadiness.length > 0 ? (
        <section
          className="data-list-card category-release-card"
          aria-labelledby="category-release-title"
          data-testid="release-readiness-card"
        >
          <header className="data-list-card-head">
            <h2 id="category-release-title">Yayın hazırlığı</h2>
            <span className="admin-toolbar-summary" data-testid="release-readiness-summary">
              {readyCount} / {draftReadiness.length} hizmet hazır
            </span>
            <p className="cell-muted">
              Taslak hizmetler yalnızca bu panelde görünür. Bir hizmeti{' '}
              <strong>{STATUS_LABELS.ACTIVE}</strong> yapmadan önce teklif kredisinin tanımlı ve
              kategoriye bağlı onaylı bir hizmet verenin var olduğundan emin olun. Bu liste
              filtrelerden bağımsızdır.
            </p>
          </header>
          <DataTable
            caption="Yayın hazırlığı"
            columns={RELEASE_COLUMNS}
            minWidth={1080}
            testId="release-readiness-table"
          >
            {draftReadiness.map(({ category, blockers }) => {
              const parent = category.parentId ? categoriesById.get(category.parentId) : undefined;
              const providers = category._count?.providers ?? 0;
              const activeInvites = category._count?.providerInvites ?? 0;
              const enrollment = enrollmentSentence(category);

              return (
                <tr key={category.id} data-testid={`release-row-${category.slug}`}>
                  <td>
                    <div className="cell-stack">
                      <Link className="cell-link cell-break" href={`/categories/${category.slug}`}>
                        <strong>{category.name}</strong>
                      </Link>
                      <code className="cell-muted cell-break">{category.slug}</code>
                    </div>
                  </td>
                  <td>
                    {parent ? (
                      <Link className="cell-break" href={`/categories/${parent.slug}`}>
                        {parent.name}
                      </Link>
                    ) : (
                      <span className="cell-muted">üst seviye</span>
                    )}
                  </td>
                  <td className="is-num">{category._count?.questions ?? 0}</td>
                  <td className="is-num">
                    {category.offerCreditCost === null ? (
                      <span className="badge badge-bad" title={RELEASE_BLOCKER_HINTS.NO_PRICE}>
                        {RELEASE_BLOCKER_LABELS.NO_PRICE}
                      </span>
                    ) : (
                      <strong>{category.offerCreditCost}</strong>
                    )}
                  </td>
                  <td className="is-num">
                    {providers === 0 ? (
                      <span className="badge badge-bad" title={RELEASE_BLOCKER_HINTS.NO_APPROVED_PROVIDER}>
                        0
                      </span>
                    ) : (
                      <strong>{providers}</strong>
                    )}
                  </td>
                  {/*
                    Sourcing progress, sitting next to the verdict and
                    deliberately not part of it. "Three businesses have been
                    approached" is a different sentence from "three businesses
                    can answer a request", and only the second one releases a
                    service — so this column never turns a row green, and the
                    readiness rules never read it.
                  */}
                  <td className="is-num" data-testid={`release-invites-${category.slug}`}>
                    {activeInvites === 0 ? <span className="cell-muted">0</span> : <strong>{activeInvites}</strong>}
                  </td>
                  {/*
                    The supply reading, next to the release verdict and
                    deliberately not merged into it. A draft can have its
                    providers and still be unreleasable for want of a price, and
                    that is the row somebody acts on differently.
                  */}
                  <td data-testid={`supply-status-${category.slug}`}>
                    <div className="cell-stack">
                      {category.supplyStatus ? (
                        <span className={supplyStatusBadgeClass(category.supplyStatus)}>
                          {SUPPLY_STATUS_LABELS[category.supplyStatus]}
                        </span>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                      {enrollment ? (
                        <span className="cell-muted" data-testid={`enrollment-note-${category.slug}`}>
                          {enrollment}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="release-verdict-cell">
                    <TreeReadiness blockers={blockers} explain />
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </section>
      ) : null}

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Kategori filtreleri"
        testId="category-filters"
      >
        <FilterField label="Ara" htmlFor="category-search" wide>
          <input
            id="category-search"
            name="q"
            type="search"
            placeholder="Kategori adı veya kısa ad"
            defaultValue={query}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Durum" htmlFor="category-status">
          <select id="category-status" name="status" defaultValue={status}>
            <option value="">Tümü</option>
            <option value="DRAFT">{STATUS_LABELS.DRAFT}</option>
            <option value="ACTIVE">{STATUS_LABELS.ACTIVE}</option>
            <option value="INACTIVE">{STATUS_LABELS.INACTIVE}</option>
          </select>
        </FilterField>
      </FilterBar>

      <section className="data-list-card" aria-labelledby="category-tree-title">
        <header className="data-list-card-head">
          <h2 id="category-tree-title">Kategori ağacı</h2>
          <p className="cell-muted">
            Alt kategoriler üst grubunun altında, girintili listelenir. Soru seti, yönlendirme ve
            davetler için kategoriyi açın.
          </p>
        </header>
        {filtered.length === 0 ? (
          categories.length === 0 ? (
            <EmptyState
              title="Henüz kategori yok."
              description="İlk kategoriyi oluşturduğunuzda burada listelenecek."
              action={newCategoryLink}
            />
          ) : (
            <EmptyState
              title="Aramana uygun kategori bulunamadı."
              description="Filtreleri temizleyerek tüm kategorileri görebilirsin."
              action={
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Filtreleri temizle
                </Link>
              }
            />
          )
        ) : (
          <DataTable caption="Kategori ağacı" columns={TREE_COLUMNS} minWidth={1080} testId="category-tree-table">
            {rows.map(({ category, depth }) => {
              const context = treeRowContext(category, categoriesById);
              const isLeaf = category.kind === 'LEAF';
              const providers = category._count?.providers ?? 0;

              return (
                <tr key={category.id} data-testid={`category-row-${category.slug}`}>
                  <td className="cat-list-thumb-cell">
                    {category.imageUrl ? (
                      <img src={category.imageUrl} alt="" className="cat-list-thumb" loading="lazy" />
                    ) : (
                      <span className="cat-list-thumb-placeholder" aria-hidden="true">
                        {category.iconKey ? category.iconKey.slice(0, 3) : '—'}
                      </span>
                    )}
                  </td>
                  <td>
                    <div
                      className="cell-stack category-tree-name"
                      style={depth > 0 ? { paddingLeft: depth * 20 } : undefined}
                      data-depth={depth}
                    >
                      <Link
                        className="cell-link cell-break"
                        href={`/categories/${category.slug}`}
                        id={`category-name-${category.id}`}
                      >
                        <strong>{category.name}</strong>
                      </Link>
                      {context ? <span className="cell-muted cell-break">{context}</span> : null}
                    </div>
                  </td>
                  <td>
                    <code className="cell-break">{category.slug}</code>
                  </td>
                  <td>{KIND_LABELS[category.kind]}</td>
                  <td>
                    <span className={statusBadgeClass(category.status)}>{STATUS_LABELS[category.status]}</span>
                  </td>
                  <td className="is-num">
                    {!isLeaf ? (
                      <span className="cell-muted" title="Yalnız hizmet kategorilerinde teklif verilir.">
                        —
                      </span>
                    ) : category.offerCreditCost === null ? (
                      <span
                        className="badge badge-bad"
                        title="Fiyat tanımlı olmadığı için bu kategoride teklif verilemez."
                      >
                        Fiyat tanımsız
                      </span>
                    ) : (
                      <strong>{category.offerCreditCost}</strong>
                    )}
                  </td>
                  <td className="is-num">{category._count?.questions ?? 0}</td>
                  <td className="is-num">
                    {!isLeaf ? (
                      <span className="cell-muted" title="Yalnız hizmet kategorilerine hizmet veren bağlanır.">
                        —
                      </span>
                    ) : providers === 0 ? (
                      <span className="badge badge-bad" title={RELEASE_BLOCKER_HINTS.NO_APPROVED_PROVIDER}>
                        0
                      </span>
                    ) : (
                      <strong>{providers}</strong>
                    )}
                  </td>
                  <td data-testid={`tree-readiness-${category.slug}`}>
                    {isLeaf ? (
                      <TreeReadiness blockers={releaseBlockers(category)} />
                    ) : (
                      <span className="cell-muted" title="Grup ve yönlendirici talep almaz; yayın kontrolü hizmetler içindir.">
                        —
                      </span>
                    )}
                  </td>
                  <td className="is-num">{category.sortOrder}</td>
                  <td className="col-actions">
                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/categories/${category.slug}`}
                      aria-describedby={`category-name-${category.id}`}
                    >
                      Aç
                    </Link>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {filtered.length > 0 ? (
          <WholeListFooter
            count={filtered.length}
            total={categories.length}
            noun="kategori"
            summaryTestId="category-count"
          />
        ) : null}
      </section>
    </main>
  );
}
