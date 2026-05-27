import Link from 'next/link';
import { apiFetch, Category } from '../../lib/api';

export default async function CategoriesPage() {
  const categories = await apiFetch<Category[]>('/categories');

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Hizmet Kategorileri</h1>
        <p className="page-subtitle">İhtiyacınız olan kategoriyi seçin, dakikalar içinde talep oluşturun.</p>
      </header>

      {categories.length === 0 ? (
        <div className="empty-state">
          <h2>Henüz kategori yok</h2>
          <p className="muted">Yeni kategoriler eklendiğinde burada listelenecek.</p>
        </div>
      ) : null}

      <section className="card-grid">
        {categories.map((category) => (
          <article className="card" key={category.id}>
            <h2 className="list-card-title">
              <Link href={`/categories/${category.slug}`}>{category.name}</Link>
            </h2>
            {category.description ? (
              <p className="muted" style={{ fontSize: 13 }}>{category.description}</p>
            ) : null}
            <div>
              <Link className="btn btn-primary btn-sm" href={`/categories/${category.slug}`}>
                Talep oluştur
              </Link>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
