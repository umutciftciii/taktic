import Link from 'next/link';
import { apiFetch, Category, requireAdmin } from '../../lib/api';

export default async function AdminCategoriesPage() {
  await requireAdmin();
  const categories = await apiFetch<Category[]>('/categories?includeInactive=true');

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Kategoriler</h1>
        <p className="page-subtitle">Hizmet kategorilerini ve dinamik talep sorularını yönetin.</p>
      </header>

      <div className="inline-actions" style={{ marginBottom: 18 }}>
        <Link className="btn btn-primary btn-sm" href="/categories/new">Yeni Kategori</Link>
      </div>

      <div className="table-card">
        <div className="table-header">
          <h2>Kategori listesi</h2>
          <span className="muted" style={{ fontSize: 13 }}>{categories.length} kayıt</span>
        </div>
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
                  <td><code style={{ fontSize: 12 }}>{category.slug}</code></td>
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
      </div>
    </main>
  );
}
