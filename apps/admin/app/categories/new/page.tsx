import Link from 'next/link';
import { createCategoryAction } from '../actions';
import { CategoryImageUploader } from '../category-image-uploader';
import { apiFetch, CATEGORY_ICON_KEYS, Category, requireAdmin } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import {
  CATEGORY_KINDS,
  CATEGORY_STATUSES,
  KIND_HINTS,
  KIND_LABELS,
  STATUS_HINTS,
  STATUS_LABELS,
} from '../category-taxonomy';

export default async function NewCategoryPage() {
  await requireAdmin();
  const categories = await apiFetch<Category[]>('/categories?includeInactive=true');
  // Only a GROUP can be a parent — a service is not a folder — so the picker
  // offers exactly what the API will accept.
  const groups = categories.filter((category) => category.kind === 'GROUP');

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
                <label className="field field-4">
                  <span>Teklif kredisi *</span>
                  <input name="offerCreditCost" type="number" min="1" step="1" defaultValue="1" required />
                  <span className="help-text">
                    Bu kategoride bir teklifin maliyeti. Yalnız hizmet tipinde kullanılır; grup ve
                    yönlendirici kategorilerde teklif verilemediği için yok sayılır.
                  </span>
                </label>
                <label className="field field-4">
                  <span>Tip *</span>
                  <select name="kind" defaultValue="LEAF">
                    {CATEGORY_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                  <span className="help-text">{KIND_HINTS.LEAF}</span>
                </label>
                <label className="field field-4">
                  <span>Durum *</span>
                  <select name="status" defaultValue="DRAFT">
                    {CATEGORY_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                  <span className="help-text">{STATUS_HINTS.DRAFT}</span>
                </label>
                <label className="field field-4">
                  <span>Üst kategori</span>
                  <select name="parentId" defaultValue="">
                    <option value="">— (üst seviye)</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                  <span className="help-text">
                    Yalnızca grup tipindeki kategoriler üst kategori olabilir.
                  </span>
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
                <CategoryImageUploader
                  name="imageUrl"
                  label="Kart görseli"
                  variant="card"
                  helpText="Kategoriler listesindeki kart için kullanılır."
                />
                <CategoryImageUploader
                  name="coverImageUrl"
                  label="Kapak görseli"
                  variant="cover"
                  helpText="Kategori detay sayfasının geniş kapak görseli. Boş bırakılırsa cover gösterilmez."
                />
                <label className="field field-12">
                  <span>Fallback ikon anahtarı</span>
                  <select name="iconKey" defaultValue="">
                    <option value="">— (otomatik ikon kullan)</option>
                    {CATEGORY_ICON_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                  </select>
                  <span className="help-text">
                    Görsel verilmediğinde kullanılacak ikon. Boş bırakılırsa kategori adına göre
                    otomatik fallback ikon kullanılır. Upload sistemi ayrı fazda eklenecek.
                  </span>
                </label>
              </div>

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
              <li>{STATUS_HINTS.DRAFT}</li>
              <li>{KIND_HINTS.ROUTER}</li>
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
