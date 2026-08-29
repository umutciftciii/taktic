import Link from 'next/link';
import { apiFetch, Category, CategoryStatus, requireAdmin } from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { EmptyState } from '../../components/empty-state';
import {
  KIND_LABELS,
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
            <table className="data-table">
              <thead>
                <tr>
                  <th className="cat-list-thumb-cell" aria-label="Görsel" />
                  <th>Kategori adı</th>
                  <th>Slug</th>
                  <th>Tip</th>
                  <th>Durum</th>
                  <th className="col-num">Teklif Kredisi</th>
                  <th className="col-num">Soru sayısı</th>
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
