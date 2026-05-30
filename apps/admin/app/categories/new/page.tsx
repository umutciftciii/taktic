import Link from 'next/link';
import { createCategoryAction } from '../actions';
import { requireAdmin } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

export default async function NewCategoryPage() {
  await requireAdmin();

  return (
    <main className="categories-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Kategoriler', href: '/categories' },
          { label: 'Yeni' },
        ]}
        title="Yeni Kategori"
        subtitle="Hizmet kategorisi oluşturun. Sorular kategori oluşturulduktan sonra eklenebilir."
      />

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Kategori bilgileri"
            subtitle="Listede ve müşteri akışında görünecek temel alanlar."
          >
            <form action={createCategoryAction} className="compact-form">
              <div className="compact-field-grid">
                <label className="field field-8">
                  <span>İsim *</span>
                  <input name="name" required autoFocus />
                </label>
                <label className="field field-4">
                  <span>Sıralama</span>
                  <input name="sortOrder" type="number" min="0" defaultValue="0" />
                </label>
                <label className="field field-12">
                  <span>Slug *</span>
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    placeholder="ornek-kategori"
                  />
                  <span className="help-text">Yalnızca küçük harf, rakam ve tire (-).</span>
                </label>
                <label className="field field-12">
                  <span>Açıklama</span>
                  <textarea
                    name="description"
                    placeholder="Müşteri akışında kategoriyi tanıtacak kısa metin (opsiyonel)."
                  />
                </label>
              </div>

              <input type="hidden" name="isActive" value="true" />

              <div className="compact-actions">
                <button className="btn btn-primary btn-sm" type="submit">
                  Kategoriyi oluştur
                </button>
                <Link className="btn btn-secondary btn-sm" href="/categories">
                  Vazgeç
                </Link>
              </div>
            </form>
          </SectionCard>
        </div>

        <aside className="admin-side-column">
          <div className="helper-card">
            <h4>Sıradaki adım</h4>
            <p>
              Kategori oluşturulduktan sonra detay sayfasından <strong>soru seti</strong> ekleyebilir,
              durumu yönetebilirsiniz.
            </p>
            <ul>
              <li>Slug değiştirildiğinde mevcut linkler kırılır.</li>
              <li>Soru sırası, müşteri formundaki gösterim sırasını belirler.</li>
              <li>Pasif kategoriler müşteri akışında görünmez.</li>
            </ul>
          </div>

          <div className="admin-action-panel">
            <h3>İpucu</h3>
            <p>
              İsim alanını doldurduktan sonra slug'ı küçük harflerle ve tire (-) kullanarak yazın.
              Örn. <code>elektrik-tesisati</code>.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
