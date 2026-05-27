import Link from 'next/link';
import { apiFetch, Category } from '../lib/api';
import { CategorySearch } from './category-search';

export default async function HomePage() {
  const categories = await apiFetch<Category[]>('/categories?limit=12');

  return (
    <main>
      <section className="hero hero-search">
        <span className="badge badge-info" style={{ marginBottom: 14 }}>Yerel hizmet pazaryeri</span>
        <h1>Aradığın hizmeti dakikalar içinde bul.</h1>
        <p className="muted" style={{ fontSize: 17, maxWidth: 640 }}>
          İhtiyacını yaz, doğru hizmet verenler sana ulaşsın. Hizmet veren tarafında ise adil teklif kredisi
          ve iade modeli.
        </p>
        <div className="hero-search-wrap">
          <CategorySearch
            variant="hero"
            placeholder="Hangi hizmete ihtiyacın var? (ör. klima, tadilat, temizlik)"
          />
        </div>
        <div className="hero-quicklinks">
          <span className="muted">Popüler aramalar:</span>
          {categories.slice(0, 6).map((category) => (
            <Link key={category.id} href={`/categories/${category.slug}`}>
              {category.name}
            </Link>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <div className="section-heading">
          <h2 className="section-title">Hizmet kategorileri</h2>
          <Link className="section-link" href="/categories">
            Tümünü gör →
          </Link>
        </div>
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
      </section>

      <section style={{ marginTop: 32 }}>
        <div className="section-heading">
          <h2 className="section-title">Nasıl çalışır?</h2>
        </div>
        <div className="how-grid">
          <article className="how-step">
            <span className="how-step-number">1</span>
            <h3>Talebini oluştur</h3>
            <p className="muted">
              Kategoriyi seç, kısa sorulara yanıt ver. Konum ve bütçeni belirt. Saniyeler içinde tamam.
            </p>
          </article>
          <article className="how-step">
            <span className="how-step-number">2</span>
            <h3>Teklifleri karşılaştır</h3>
            <p className="muted">
              Sana özel teklif veren hizmet verenler arasından fiyat, süre ve mesajlarına bakarak en uygunu
              seç.
            </p>
          </article>
          <article className="how-step">
            <span className="how-step-number">3</span>
            <h3>Güvenle hizmet al</h3>
            <p className="muted">
              Kabul ettiğin teklifin hizmet vereni iletişime geçer. Memnun kalmazsan iade politikası
              devreye girer.
            </p>
          </article>
        </div>
      </section>

      <section style={{ marginTop: 32 }} className="cta-band">
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Hizmet veren misin?</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            TakTic, adil teklif kredisi ve iade politikası ile düşük kaliteli leadlerden seni korur.
          </p>
        </div>
        <div className="inline-actions">
          <Link className="btn btn-primary" href="/providers/register">Hizmet Ver</Link>
          <Link className="btn btn-secondary" href="/login">Giriş yap</Link>
        </div>
      </section>
    </main>
  );
}
