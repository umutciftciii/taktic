import Link from 'next/link';
import { apiFetch, Category } from '../../lib/api';
import { CategorySearch } from '../category-search';
import { CategoryVisual } from '../category-visual';
import { IconArrowRight } from '../landing-icons';

type CategoriesPageProps = {
  searchParams: Promise<{ q?: string }>;
};

/** Free-text shortcuts; each one really performs the `?q=` search below. */
const POPULAR_SEARCHES = ['Klima', 'Kombi', 'Elektrikçi', 'Su tesisatı', 'Boya badana', 'Ev temizliği'];

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
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <span>Kategoriler</span>
        </nav>

        <header className="cat-page-head">
          <h1 className="cat-page-title">Hizmet kategorileri</h1>
          <p className="cat-page-subtitle">
            Kategoriyi seç, o kategoriye özel soruları yanıtla. Talebin incelendikten sonra
            bölgendeki onaylı hizmet verenlere iletilir.
          </p>
        </header>

        <div className="cat-page-search">
          <CategorySearch
            variant="hero"
            placeholder="Kategori ara — örn. klima, boya, tesisat"
          />
        </div>

        <div className="cat-page-popular">
          <span className="cat-page-popular-label">Popüler aramalar:</span>
          {POPULAR_SEARCHES.map((label) => (
            <Link
              className="tag-outline"
              key={label}
              href={`/categories?q=${encodeURIComponent(label)}`}
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="cat-page-body">
          <aside className="cat-page-rail" aria-label="Kategori filtreleri">
            <div className="cat-rail-group">
              <span className="cat-rail-title">Arama</span>
              <p className="lp-muted" style={{ fontSize: 13, margin: 0 }}>
                {hasSearch ? (
                  <>
                    “{term}” için filtrelenmiş liste. <Link href="/categories">Aramayı temizle</Link>
                  </>
                ) : (
                  'Tüm aktif kategoriler listeleniyor.'
                )}
              </p>
            </div>

            {/*
              Bölge ve grup kırılımı için API tarafında bir uç yok; alan sahte
              sonuç üretmemek adına pasif "Yakında" olarak duruyor.
            */}
            <div className="cat-rail-group">
              <span className="cat-rail-title">Şehir</span>
              <select className="sel" aria-label="Şehir (yakında)" disabled defaultValue="">
                <option value="">Tümü</option>
              </select>
              <span className="help-text">Bölgeye göre filtreleme yakında.</span>
            </div>

            <div className="cat-rail-cta">
              <p className="lp-muted" style={{ fontSize: 13 }}>
                Aradığın kategori listede yoksa en yakın kategoriden talep açabilir, iş detayını
                açıklama alanında anlatabilirsin.
              </p>
              <Link className="btn btn-secondary btn-block" href="/#lp-sss">
                Nasıl çalışır?
                <IconArrowRight size={12} />
              </Link>
            </div>
          </aside>

          <div className="cat-page-results">
            <div className="cat-page-meta">
              <span className="cat-page-meta-text">
                {isEmpty
                  ? hasSearch
                    ? `“${term}” için sonuç bulunamadı`
                    : 'Kategori bulunamadı'
                  : hasSearch
                    ? `“${term}” için ${categories.length} kategori`
                    : `${categories.length} kategori`}
              </span>
              {hasSearch ? (
                <Link className="cat-page-meta-link" href="/categories">
                  Aramayı temizle
                </Link>
              ) : null}
            </div>

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
              <div className="cat-row-list">
                {categories.map((category) => (
                  <Link
                    className="cat-row"
                    href={`/categories/${category.slug}`}
                    key={category.id}
                  >
                    <span className="cat-row-media">
                      <CategoryVisual
                        imageUrl={category.imageUrl}
                        slug={category.slug}
                        iconKey={category.iconKey}
                        name={category.name}
                        iconSize={28}
                        alt=""
                      />
                    </span>
                    <span className="cat-row-body">
                      <span className="cat-row-name">{category.name}</span>
                      {category.description ? (
                        <span className="cat-row-desc">{category.description}</span>
                      ) : null}
                    </span>
                    <span className="cat-row-cta">
                      <span className="btn btn-secondary btn-sm">
                        Talep oluştur
                        <IconArrowRight size={12} />
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
