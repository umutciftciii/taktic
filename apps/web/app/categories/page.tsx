import Link from 'next/link';
import { apiFetch, Category } from '../../lib/api';
import { CategorySearch } from '../category-search';

type CategoriesPageProps = {
  searchParams: Promise<{ q?: string }>;
};

export default async function CategoriesPage({ searchParams }: CategoriesPageProps) {
  const { q } = await searchParams;
  const term = q?.trim() ?? '';
  const path = term ? `/categories?q=${encodeURIComponent(term)}` : '/categories';
  const categories = await apiFetch<Category[]>(path);

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">
          {term ? `“${term}” için sonuçlar` : 'Hizmet Kategorileri'}
        </h1>
        <p className="page-subtitle">
          {term
            ? `${categories.length} eşleşen kategori`
            : 'İhtiyacınız olan kategoriyi seçin, dakikalar içinde talep oluşturun.'}
        </p>
      </header>

      <div className="page-narrow" style={{ marginBottom: 22 }}>
        <CategorySearch
          variant="hero"
          placeholder="Kategori ara (ör. klima, tadilat, temizlik)"
        />
      </div>

      {term ? (
        <div className="inline-actions" style={{ marginBottom: 14 }}>
          <Link className="btn btn-secondary btn-sm" href="/categories">
            Aramayı temizle
          </Link>
        </div>
      ) : null}

      {categories.length === 0 ? (
        <div className="empty-state">
          <h2>{term ? 'Eşleşen kategori bulunamadı' : 'Henüz kategori yok'}</h2>
          <p className="muted">
            {term
              ? 'Farklı bir anahtar kelime deneyin veya tüm kategorileri inceleyin.'
              : 'Yeni kategoriler eklendiğinde burada listelenecek.'}
          </p>
          {term ? (
            <Link className="btn btn-primary" href="/categories" style={{ marginTop: 8 }}>
              Tüm kategorilere dön
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="category-tile-grid">
          {categories.map((category) => (
            <Link className="category-tile" href={`/categories/${category.slug}`} key={category.id}>
              <span className="category-tile-mark" aria-hidden="true">
                {category.name.charAt(0)}
              </span>
              <span className="category-tile-name">{category.name}</span>
              {category.description ? (
                <span className="category-tile-desc">{category.description}</span>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
