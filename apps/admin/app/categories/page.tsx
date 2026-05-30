import Link from 'next/link';
import { apiFetch, Category, requireAdmin } from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { EmptyState } from '../../components/empty-state';

export default async function AdminCategoriesPage() {
  await requireAdmin();
  const categories = await apiFetch<Category[]>('/categories?includeInactive=true');

  return (
    <main>
      <PageHeader
        title="Kategoriler"
        subtitle="Hizmet kategorilerini ve dinamik talep sorularını yönetin."
        actions={
          <Link className="btn btn-primary btn-sm" href="/categories/new">
            Yeni Kategori
          </Link>
        }
      />

      <div className="table-card">
        <div className="table-header">
          <h2>Kategori listesi</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {categories.length} kayıt
          </span>
        </div>
        {categories.length === 0 ? (
          <div style={{ padding: 18 }}>
            <EmptyState
              title="Henüz kategori yok."
              description="İlk kategoriyi oluşturduğunuzda burada listelenecek."
              action={
                <Link className="btn btn-primary btn-sm" href="/categories/new">
                  Yeni Kategori
                </Link>
              }
            />
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>İsim</th>
                  <th>Slug</th>
                  <th>Durum</th>
                  <th>Sıra</th>
                  <th>Soru sayısı</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => (
                  <tr key={category.id}>
                    <td>
                      <Link href={`/categories/${category.slug}`}>{category.name}</Link>
                    </td>
                    <td>
                      <code style={{ fontSize: 12 }}>{category.slug}</code>
                    </td>
                    <td>
                      <span className={category.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                        {category.isActive ? 'Aktif' : 'Pasif'}
                      </span>
                    </td>
                    <td>{category.sortOrder}</td>
                    <td>{category._count?.questions ?? 0}</td>
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
