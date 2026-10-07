import Link from 'next/link';
import { createCategoryAction } from '../actions';
import { CategoryCreateSubmit } from '../category-gates';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../../lib/confirmation-proof-keys';
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

/**
 * A new category (#39). The design has no screen for it (`soon`), so it is
 * built on the form template (ADMIN-DESIGN-001 Faz 3F): a way back to the
 * list, the title with its ⓘ — which now carries what the side cards said —
 * and the form, whose twelve fields, names and action are unchanged.
 */
export default async function NewCategoryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { can } = await requireAdmin('CATALOG_READ', 'CATEGORIES_WRITE');
  const canUpload = can('UPLOADS_WRITE');
  // Creating straight into ACTIVE or INACTIVE is a status decision, so the API
  // asks for CATEGORIES_STATUS as well (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  // Without it the form offers DRAFT only.
  const canChooseStatus = can('CATEGORIES_STATUS');
  const categories = await apiFetch<Category[]>('/admin/categories');
  // Only a GROUP can be a parent — a service is not a folder — so the picker
  // offers exactly what the API will accept.
  const groups = categories.filter((category) => category.kind === 'GROUP');

  return (
    <main className="catalog-page catalog-form-page">
      <Link className="detail-back" href="/categories">
        <span aria-hidden="true">‹</span> Hizmet kategorileri
      </Link>
      <PageHeader
        title="Yeni kategori"
        subtitle="Hizmet kategorisi oluşturun. Sorular, yönlendirme ve davetler kategori oluşturulduktan sonra detay ekranında eklenir."
        infoLabel="Kategori nasıl oluşturulur?"
        info={
          <span className="popover-list">
            <span>Kaydettikten sonra kategorinin detay ekranı açılır; soru seti, durum ve davetler oradan yönetilir.</span>
            <span>Kısa ad (slug) yalnız küçük harf, rakam ve tire içerir; örn. elektrik-tesisati. Kategorinin adresi olur: /categories/kısa-ad. Sonradan yalnız “SEO ve adresler → Adresler” ekranından değiştirilir.</span>
            <span>Soru sırası müşteri formundaki gösterim sırasını belirler.</span>
            <span>{STATUS_HINTS.DRAFT}</span>
            <span>{KIND_HINTS.ROUTER}</span>
          </span>
        }
      />

      {error === 'CONFIRMATION_REQUIRED' ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="category-error">
          {CONFIRMATION_PROOF_REFUSAL_MESSAGE}
        </div>
      ) : null}

      <div className="catalog-stack">
        <SectionCard
          title="Kategori bilgileri"
          subtitle="Listede ve müşteri akışında görünecek temel alanlar."
        >
          <form action={createCategoryAction} className="compact-form">
            <div className="compact-field-grid">
              <label className="field field-8">
                <span>Kategori adı *</span>
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
                {canChooseStatus ? (
                  <select name="status" defaultValue="DRAFT" data-testid="category-new-status">
                    {CATEGORY_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    {/*
                      No CATEGORIES_STATUS: DRAFT is the only status on offer.
                      Sent by the hidden field — a disabled select never reaches
                      FormData, and a create naming no status means ACTIVE,
                      which the API would refuse.
                    */}
                    <input type="hidden" name="status" value="DRAFT" />
                    <select defaultValue="DRAFT" disabled data-testid="category-new-status">
                      <option value="DRAFT">{STATUS_LABELS.DRAFT}</option>
                    </select>
                  </>
                )}
                <span className="help-text" data-testid="category-new-status-help">
                  {canChooseStatus
                    ? STATUS_HINTS.DRAFT
                    : `${STATUS_HINTS.DRAFT} Yayına almak kategori durumu yetkisi gerektirir; bu yetkiye sahip biri detay ekranından yayına alabilir.`}
                </span>
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
                <span>Kısa ad (slug) *</span>
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
                canUpload={canUpload}
                name="imageUrl"
                label="Kart görseli"
                variant="card"
                helpText="Kategoriler listesindeki kart için kullanılır."
              />
              <CategoryImageUploader
                canUpload={canUpload}
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
                  otomatik fallback ikon kullanılır.
                </span>
              </label>
            </div>

            <div className="compact-actions">
              {/*
                A DRAFT goes straight through; ACTIVE or INACTIVE asks first
                (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B), and the action
                refuses it without the dialog's proof.
              */}
              <CategoryCreateSubmit />
              <Link className="btn btn-secondary btn-sm" href="/categories">
                Vazgeç
              </Link>
            </div>
          </form>
        </SectionCard>
      </div>
    </main>
  );
}
