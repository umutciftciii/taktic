import Link from 'next/link';
import { apiFetch, Category } from '../../lib/api';
import { CategorySearch } from '../category-search';
import { CategoryVisual } from '../category-visual';
import { IconArrowRight } from '../landing-icons';

type CategoriesPageProps = {
  searchParams: Promise<{ q?: string }>;
};

export default async function CategoriesPage({ searchParams }: CategoriesPageProps) {
  const { q } = await searchParams;
  const term = q?.trim() ?? '';
  const path = term ? `/categories?q=${encodeURIComponent(term)}` : '/categories';
  const categories = await apiFetch<Category[]>(path);

  const hasSearch = term.length > 0;
  const isEmpty = categories.length === 0;

  return (
    <main className="cat-page">
      <div className="cat-page-shell">
        <header className="cat-page-head">
          <h1 className="cat-page-title">Hizmet Kategorileri</h1>
          <p className="cat-page-subtitle">
            İhtiyacına uygun kategoriyi seç, dakikalar içinde talep oluştur.
          </p>
        </header>

        <div className="cat-page-search">
          <CategorySearch
            variant="hero"
            placeholder="Kategori ara (örn. klima, tadilat, temizlik)"
          />
        </div>

        {hasSearch ? (
          <div className="cat-page-meta">
            <span className="cat-page-meta-text">
              {isEmpty
                ? `“${term}” için sonuç bulunamadı`
                : `“${term}” için ${categories.length} kategori`}
            </span>
            <Link className="cat-page-meta-link" href="/categories">
              Aramayı temizle
            </Link>
          </div>
        ) : null}

        {isEmpty ? (
          <div className="cat-page-empty">
            <h2 className="cat-page-empty-title">
              {hasSearch ? 'Aramana uygun kategori bulunamadı.' : 'Henüz kategori yok.'}
            </h2>
            <p className="cat-page-empty-desc">
              {hasSearch
                ? 'Farklı bir anahtar kelime dene veya tüm kategorilere göz at.'
                : 'Yeni kategoriler eklendiğinde burada listelenecek.'}
            </p>
            {hasSearch ? (
              <Link className="cat-page-empty-cta" href="/categories">
                Tüm kategorileri göster
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="cat-page-grid">
            {categories.map((category) => {
              const hasImage = Boolean(category.imageUrl);
              return (
                <Link
                  className={`cat-page-card${hasImage ? ' cat-page-card-with-image' : ''}`}
                  href={`/categories/${category.slug}`}
                  key={category.id}
                >
                  {hasImage ? (
                    <span className="cat-page-card-media">
                      <CategoryVisual
                        imageUrl={category.imageUrl}
                        iconKey={category.iconKey}
                        name={category.name}
                        imgClassName="cat-page-card-img"
                        iconWrapperClassName="cat-page-card-icon"
                        iconSize={22}
                        alt={category.name}
                      />
                    </span>
                  ) : (
                    <CategoryVisual
                      imageUrl={category.imageUrl}
                      iconKey={category.iconKey}
                      name={category.name}
                      iconWrapperClassName="cat-page-card-icon"
                      iconSize={22}
                      alt={category.name}
                    />
                  )}
                  <span className="cat-page-card-name">{category.name}</span>
                  {category.description ? (
                    <span className="cat-page-card-desc">{category.description}</span>
                  ) : null}
                  <span className="cat-page-card-cta">
                    Talep oluştur
                    <IconArrowRight size={12} />
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
