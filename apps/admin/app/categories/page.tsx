import Link from 'next/link';
import { apiFetch, Category, CategoryStatus, requireAdmin } from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { EmptyState } from '../../components/empty-state';
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

type StatusFilter = 'all' | CategoryStatus;

type AdminCategoriesPageProps = {
  searchParams: Promise<{ q?: string; status?: string }>;
};

function normalizeStatus(value: string | undefined): StatusFilter {
  if (value === 'DRAFT' || value === 'ACTIVE' || value === 'INACTIVE') return value;
  // `active` / `inactive` are what the pre-taxonomy links carried; a bookmarked
  // filter should keep meaning what it meant.
  if (value === 'active') return 'ACTIVE';
  if (value === 'inactive') return 'INACTIVE';
  return 'all';
}

export default async function AdminCategoriesPage({ searchParams }: AdminCategoriesPageProps) {
  await requireAdmin();
  const { q: rawQuery, status: rawStatus } = await searchParams;
  const query = (rawQuery ?? '').trim();
  const status = normalizeStatus(rawStatus);

  const categories = await apiFetch<Category[]>('/categories?includeInactive=true');

  const normalizedQuery = query.toLocaleLowerCase('tr-TR');
  const filtered = categories.filter((category) => {
    if (status !== 'all' && category.status !== status) return false;
    if (!normalizedQuery) return true;
    const haystack = `${category.name} ${category.slug}`.toLocaleLowerCase('tr-TR');
    return haystack.includes(normalizedQuery);
  });

  // Children follow their parent, indented. The search and status filters run
  // first, so a filtered list is a filtered tree rather than a tree with holes.
  const rows = toTreeRows(filtered);

  const hasFilters = query.length > 0 || status !== 'all';

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

  return (
    <main className="categories-page">
      <PageHeader
        title="Kategoriler"
        subtitle="Hizmet talep akışında kullanılan kategori ağacını yönetin."
        actions={
          <Link className="btn btn-primary btn-sm" href="/categories/new">
            Yeni Kategori
          </Link>
        }
      />

      {draftReadiness.length > 0 ? (
        <SectionCard
          className="category-release-card"
          title="Yayın hazırlığı"
          subtitle={
            <>
              Taslak hizmetler yalnızca bu panelde görünür. Bir hizmeti{' '}
              <strong>{STATUS_LABELS.ACTIVE}</strong> yapmadan önce teklif kredisinin tanımlı ve
              kategoriye bağlı onaylı bir hizmet verenin var olduğundan emin olun.
            </>
          }
          actions={
            <span className="admin-toolbar-summary" data-testid="release-readiness-summary">
              {readyCount} / {draftReadiness.length} hizmet hazır
            </span>
          }
          padded={false}
        >
          <div className="table-scroll">
            <table className="data-table" data-testid="release-readiness-table">
              <thead>
                <tr>
                  <th>Hizmet</th>
                  <th>Üst grup</th>
                  <th className="col-num">Soru</th>
                  <th className="col-num">Teklif kredisi</th>
                  <th className="col-num">Onaylı hizmet veren</th>
                  <th className="col-num">Geçerli davet</th>
                  <th>Arz durumu</th>
                  <th>Yayına hazır mı?</th>
                </tr>
              </thead>
              <tbody>
                {draftReadiness.map(({ category, blockers }) => {
                  const parent = category.parentId
                    ? categoriesById.get(category.parentId)
                    : undefined;
                  const providers = category._count?.providers ?? 0;
                  const activeInvites = category._count?.providerInvites ?? 0;

                  return (
                    <tr key={category.id} data-testid={`release-row-${category.slug}`}>
                      <td>
                        <Link href={`/categories/${category.slug}`}>{category.name}</Link>
                        <div>
                          <code style={{ fontSize: 11 }}>{category.slug}</code>
                        </div>
                      </td>
                      <td>
                        {parent ? (
                          <Link href={`/categories/${parent.slug}`}>{parent.name}</Link>
                        ) : (
                          <span className="muted">üst seviye</span>
                        )}
                      </td>
                      <td className="col-num">{category._count?.questions ?? 0}</td>
                      <td className="col-num">
                        {category.offerCreditCost === null ? (
                          <span
                            className="badge badge-bad"
                            title={RELEASE_BLOCKER_HINTS.NO_PRICE}
                          >
                            {RELEASE_BLOCKER_LABELS.NO_PRICE}
                          </span>
                        ) : (
                          <strong>{category.offerCreditCost}</strong>
                        )}
                      </td>
                      <td className="col-num">
                        {providers === 0 ? (
                          <span
                            className="badge badge-bad"
                            title={RELEASE_BLOCKER_HINTS.NO_APPROVED_PROVIDER}
                          >
                            0
                          </span>
                        ) : (
                          <strong>{providers}</strong>
                        )}
                      </td>
                      {/*
                        Sourcing progress, sitting next to the verdict and
                        deliberately not part of it. "Three businesses have been
                        approached" is a different sentence from "three
                        businesses can answer a request", and only the second
                        one releases a service — so this column never turns a
                        row green, and the readiness rules never read it.
                      */}
                      <td className="col-num" data-testid={`release-invites-${category.slug}`}>
                        {activeInvites === 0 ? (
                          <span className="muted">0</span>
                        ) : (
                          <strong>{activeInvites}</strong>
                        )}
                      </td>
                      {/*
                        The supply reading, next to the release verdict and
                        deliberately not merged into it. A draft can have its
                        providers and still be unreleasable for want of a price,
                        and that is the row somebody acts on differently.
                      */}
                      <td data-testid={`supply-status-${category.slug}`}>
                        {category.supplyStatus ? (
                          <span className={supplyStatusBadgeClass(category.supplyStatus)}>
                            {SUPPLY_STATUS_LABELS[category.supplyStatus]}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                        {enrollmentSentence(category) ? (
                          <div
                            className="muted"
                            data-testid={`enrollment-note-${category.slug}`}
                            style={{ fontSize: 12 }}
                          >
                            {enrollmentSentence(category)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {blockers.length === 0 ? (
                          <span className="badge badge-good">Hazır</span>
                        ) : (
                          // Label *and* reason, in the row itself. The reason
                          // used to live in a title attribute, which a mouse
                          // reveals and a keyboard, a phone and a screenshot in
                          // a release meeting do not — and "why is this not
                          // ready" is the only question this table is asked.
                          <span className="release-blocker-list">
                            <span className="badge badge-warn">Hazır değil</span>
                            {blockers.map((blocker) => (
                              <span
                                className="muted"
                                data-testid={`release-blocker-${blocker}`}
                                key={blocker}
                                style={{ fontSize: 12 }}
                              >
                                <strong>{RELEASE_BLOCKER_LABELS[blocker]}.</strong>{' '}
                                {RELEASE_BLOCKER_HINTS[blocker]}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      <form className="admin-toolbar" method="get" action="/categories">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="category-search">Ara</label>
          <input
            id="category-search"
            name="q"
            type="search"
            placeholder="Kategori adı veya slug"
            defaultValue={query}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="category-status">Durum</label>
          <select id="category-status" name="status" defaultValue={status}>
            <option value="all">Tümü</option>
            <option value="DRAFT">{STATUS_LABELS.DRAFT}</option>
            <option value="ACTIVE">{STATUS_LABELS.ACTIVE}</option>
            <option value="INACTIVE">{STATUS_LABELS.INACTIVE}</option>
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/categories">
              Sıfırla
            </Link>
          ) : null}
        </div>
      </form>

      <div className="table-card">
        <div className="table-header">
          <div className="table-header-text">
            <h2>Kategori ağacı</h2>
            <p className="table-header-sub">
              Grup, hizmet ve yönlendirici kategorileri ile soru setlerini yönetin.
            </p>
          </div>
          <span className="admin-toolbar-summary">
            {filtered.length} / {categories.length} kayıt
          </span>
        </div>
        {filtered.length === 0 ? (
          <div style={{ padding: 18 }}>
            {categories.length === 0 ? (
              <EmptyState
                title="Henüz kategori yok."
                description="İlk kategoriyi oluşturduğunuzda burada listelenecek."
                action={
                  <Link className="btn btn-primary btn-sm" href="/categories/new">
                    Yeni Kategori
                  </Link>
                }
              />
            ) : (
              <EmptyState
                title="Aramana uygun kategori bulunamadı."
                description="Filtreleri temizleyerek tüm kategorileri görebilirsin."
                action={
                  <Link className="btn btn-secondary btn-sm" href="/categories">
                    Filtreleri temizle
                  </Link>
                }
              />
            )}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="category-tree-table">
              <thead>
                <tr>
                  <th className="cat-list-thumb-cell" aria-label="Görsel" />
                  <th>Kategori adı</th>
                  <th>Slug</th>
                  <th>Tip</th>
                  <th>Durum</th>
                  <th className="col-num">Teklif Kredisi</th>
                  <th className="col-num">Soru sayısı</th>
                  <th className="col-num">Onaylı hizmet veren</th>
                  <th className="col-num">Sıra</th>
                  <th className="col-actions">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ category, depth }) => (
                  <tr key={category.id}>
                    <td className="cat-list-thumb-cell">
                      {category.imageUrl ? (
                        <img
                          src={category.imageUrl}
                          alt=""
                          className="cat-list-thumb"
                          loading="lazy"
                        />
                      ) : (
                        <span className="cat-list-thumb-placeholder" aria-hidden="true">
                          {category.iconKey ? category.iconKey.slice(0, 3) : '—'}
                        </span>
                      )}
                    </td>
                    <td style={{ paddingLeft: 12 + depth * 18 }}>
                      <Link href={`/categories/${category.slug}`}>{category.name}</Link>
                    </td>
                    <td>
                      <code style={{ fontSize: 12 }}>{category.slug}</code>
                    </td>
                    <td>
                      <span className="meta-pill">{KIND_LABELS[category.kind]}</span>
                    </td>
                    <td>
                      <span className={statusBadgeClass(category.status)}>
                        {STATUS_LABELS[category.status]}
                      </span>
                    </td>
                    <td className="col-num">
                      {category.kind !== 'LEAF' ? (
                        <span className="muted" title="Yalnız hizmet kategorilerinde teklif verilir.">
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
                    <td className="col-num">{category._count?.questions ?? 0}</td>
                    <td className="col-num">
                      {category.kind !== 'LEAF' ? (
                        <span
                          className="muted"
                          title="Yalnız hizmet kategorilerine hizmet veren bağlanır."
                        >
                          —
                        </span>
                      ) : (category._count?.providers ?? 0) === 0 ? (
                        <span
                          className="badge badge-bad"
                          title={RELEASE_BLOCKER_HINTS.NO_APPROVED_PROVIDER}
                        >
                          0
                        </span>
                      ) : (
                        <strong>{category._count?.providers}</strong>
                      )}
                    </td>
                    <td className="col-num">{category.sortOrder}</td>
                    <td className="col-actions">
                      <Link className="btn-pill" href={`/categories/${category.slug}`}>
                        Düzenle
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
