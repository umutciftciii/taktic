import {
  createQuestionAction,
  updateCategoryAction,
  updateCategoryStatusAction,
  updateQuestionAction,
  updateQuestionStatusAction,
} from '../actions';
import { CategoryImageUploader } from '../category-image-uploader';
import {
  apiFetch,
  CATEGORY_ICON_KEYS,
  Category,
  Question,
  QuestionOption,
  QuestionType,
  requireAdmin,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { EmptyState } from '../../../components/empty-state';

const questionTypes: QuestionType[] = [
  'TEXT',
  'TEXTAREA',
  'SELECT',
  'MULTI_SELECT',
  'NUMBER',
  'BOOLEAN',
  'DATE',
  'IMAGE',
];

type CategoryDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function CategoryDetailPage({ params }: CategoryDetailPageProps) {
  await requireAdmin();
  const { slug } = await params;
  const category = await apiFetch<Category>(`/categories/${slug}?includeInactive=true`);
  const questions = await apiFetch<Question[]>(`/categories/${category.id}/questions`);

  const sortedQuestions = [...questions].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label, 'tr-TR');
  });

  return (
    <main className="categories-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Kategoriler', href: '/categories' },
          { label: category.name },
        ]}
        title={category.name}
        subtitle="Kategori bilgilerini, durumunu ve müşteri formundaki soruları yönetin."
      />

      <div className="admin-meta-pills">
        <span className={category.isActive ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}>
          {category.isActive ? 'Aktif' : 'Pasif'}
        </span>
        <span className="meta-pill">
          slug <code>{category.slug}</code>
        </span>
        <span className="meta-pill">{questions.length} soru</span>
        <span className="meta-pill">sıra {category.sortOrder}</span>
      </div>

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Kategori bilgileri"
            subtitle="Müşteri akışında görünen temel alanlar."
          >
            <form action={updateCategoryAction} className="compact-form">
              <input type="hidden" name="id" value={category.id} />
              <div className="compact-field-grid">
                <label className="field field-6">
                  <span>İsim *</span>
                  <input name="name" required defaultValue={category.name} />
                </label>
                <label className="field field-6">
                  <span>Slug *</span>
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    defaultValue={category.slug}
                  />
                </label>
                <label className="field field-3">
                  <span>Sıralama</span>
                  <input name="sortOrder" type="number" min="0" defaultValue={category.sortOrder} />
                </label>
                <label className="field field-3">
                  <span>Teklif kredisi *</span>
                  <input
                    name="offerCreditCost"
                    type="number"
                    min="1"
                    step="1"
                    required
                    defaultValue={category.offerCreditCost ?? ''}
                  />
                  <span className="help-text">
                    Yalnız bundan sonraki teklifleri etkiler; geçmiş teklif ve iadeleri
                    değiştirmez.
                  </span>
                </label>
                <label className="field field-12">
                  <span>Açıklama</span>
                  <textarea name="description" defaultValue={category.description ?? ''} />
                </label>
                <CategoryImageUploader
                  name="imageUrl"
                  label="Kart görseli"
                  variant="card"
                  defaultValue={category.imageUrl ?? ''}
                  helpText="Kategoriler listesindeki kart için kullanılır."
                />
                <CategoryImageUploader
                  name="coverImageUrl"
                  label="Kapak görseli"
                  variant="cover"
                  defaultValue={category.coverImageUrl ?? ''}
                  helpText="Kategori detay sayfasının geniş kapak görseli. Boş bırakılırsa cover gösterilmez."
                />
                <label className="field field-12">
                  <span>Fallback ikon anahtarı</span>
                  <select name="iconKey" defaultValue={category.iconKey ?? ''}>
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
              <input type="hidden" name="isActive" value={String(category.isActive)} />
              <div className="compact-actions">
                <button className="btn btn-primary btn-sm" type="submit">
                  Kategoriyi kaydet
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Slug değişirse mevcut linkler kırılır.
                </span>
              </div>
            </form>
          </SectionCard>

          <SectionCard
            title="Soru seti"
            subtitle="Bu kategori için müşteriye sorulacak dinamik sorular. Yeni soruyu en alttan ekleyebilirsiniz."
            padded={false}
          >
            <div className="question-manager">
              {sortedQuestions.length === 0 ? (
                <div style={{ padding: 18 }}>
                  <EmptyState
                    title="Bu kategoride soru yok."
                    description="Aşağıdaki “+ Yeni Soru Ekle” ile başlayabilirsiniz."
                  />
                </div>
              ) : (
                <div className="question-table">
                  <div className="question-table-head">
                    <span>Sıra</span>
                    <span>Soru</span>
                    <span>Key</span>
                    <span>Tip</span>
                    <span>Zorunlu</span>
                    <span>Durum</span>
                    <span>İşlem</span>
                  </div>
                  {sortedQuestions.map((question) => (
                    <details className="question-row" key={question.id}>
                      <summary>
                        <span className="q-order">{question.sortOrder}</span>
                        <span className="q-label">{question.label}</span>
                        <span className="q-key">
                          <code>{question.key}</code>
                        </span>
                        <span>
                          <span className="q-type-badge">{question.type}</span>
                        </span>
                        <span>
                          <span className={question.isRequired ? 'q-req-badge is-on' : 'q-req-badge'}>
                            {question.isRequired ? 'Evet' : 'Hayır'}
                          </span>
                        </span>
                        <span className="q-status">
                          <span
                            className={question.isActive ? 'badge badge-good' : 'badge badge-muted'}
                          >
                            {question.isActive ? 'Aktif' : 'Pasif'}
                          </span>
                        </span>
                        <span className="q-action">Düzenle</span>
                      </summary>
                      <div className="question-edit-panel">
                        <form action={updateQuestionAction} className="compact-form compact-form-wide">
                          <input type="hidden" name="id" value={question.id} />
                          <input type="hidden" name="categorySlug" value={category.slug} />
                          <QuestionFields question={question} />
                          <div className="panel-footer">
                            <button className="btn btn-primary btn-sm" type="submit">
                              Soruyu kaydet
                            </button>
                          </div>
                        </form>
                        <form
                          action={updateQuestionStatusAction}
                          className="status-form"
                          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                        >
                          <input type="hidden" name="id" value={question.id} />
                          <input type="hidden" name="categorySlug" value={category.slug} />
                          <input type="hidden" name="isActive" value={String(!question.isActive)} />
                          <span className="muted" style={{ fontSize: 12 }}>
                            {question.isActive
                              ? 'Pasifleştir: müşteri akışında görünmez.'
                              : 'Aktifleştir: müşteri akışında listelenir.'}
                          </span>
                          <button
                            className={
                              question.isActive
                                ? 'btn btn-danger btn-sm'
                                : 'btn btn-secondary btn-sm'
                            }
                            type="submit"
                          >
                            {question.isActive ? 'Pasifleştir' : 'Aktifleştir'}
                          </button>
                        </form>
                      </div>
                    </details>
                  ))}
                </div>
              )}

              <details className="question-create-panel">
                <summary>Yeni Soru Ekle</summary>
                <div className="question-create-panel-body">
                  <form action={createQuestionAction} className="compact-form compact-form-wide">
                    <input type="hidden" name="categoryId" value={category.id} />
                    <input type="hidden" name="categorySlug" value={category.slug} />
                    <QuestionFields />
                    <div className="compact-actions">
                      <button className="btn btn-primary btn-sm" type="submit">
                        Soruyu oluştur
                      </button>
                      <span className="muted" style={{ fontSize: 12 }}>
                        Oluşturulan soru varsayılan olarak aktif olur.
                      </span>
                    </div>
                  </form>
                </div>
              </details>
            </div>
          </SectionCard>
        </div>

        <aside className="admin-side-column">
          <div className={category.isActive ? 'admin-action-panel is-warning' : 'admin-action-panel'}>
            <h3>Kategori durumu</h3>
            <p>
              {category.isActive
                ? 'Kategori şu anda aktif. Müşteri akışında listelenir ve talep alabilir.'
                : 'Kategori şu anda pasif. Müşteri akışında görünmez.'}
            </p>
            <form action={updateCategoryStatusAction} className="panel-row">
              <input type="hidden" name="id" value={category.id} />
              <input type="hidden" name="slug" value={category.slug} />
              <input type="hidden" name="isActive" value={String(!category.isActive)} />
              <button
                className={category.isActive ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'}
                type="submit"
              >
                {category.isActive ? 'Pasifleştir' : 'Aktifleştir'}
              </button>
            </form>
          </div>

          <div className="admin-action-panel">
            <h3>Hızlı bilgi</h3>
            <p>
              Soru sırası müşteri formundaki gösterim sırasını belirler. SELECT ve MULTI_SELECT
              tiplerinde <code>options</code> JSON alanı zorunludur.
            </p>
            <p style={{ fontSize: 12 }}>
              <strong>Slug:</strong> <code>{category.slug}</code>
              <br />
              <strong>Soru sayısı:</strong> {questions.length}
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function QuestionFields({ question }: { question?: Question }) {
  return (
    <>
      <div className="compact-field-grid">
        <label className="field field-6">
          <span>Key</span>
          <input
            name="key"
            required
            pattern="[a-z0-9]+([_-][a-z0-9]+)*"
            defaultValue={question?.key ?? ''}
          />
        </label>
        <label className="field field-6">
          <span>Etiket</span>
          <input name="label" required defaultValue={question?.label ?? ''} />
        </label>
        <label className="field field-4">
          <span>Tip</span>
          <select name="type" defaultValue={question?.type ?? 'TEXT'}>
            {questionTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-4">
          <span>Zorunlu</span>
          <select name="isRequired" defaultValue={String(question?.isRequired ?? false)}>
            <option value="false">Hayır</option>
            <option value="true">Evet</option>
          </select>
        </label>
        <label className="field field-4">
          <span>Sıralama</span>
          <input
            name="sortOrder"
            type="number"
            min="0"
            defaultValue={question?.sortOrder ?? 0}
          />
        </label>
        <label className="field field-12">
          <span>Yardım metni</span>
          <input name="helpText" defaultValue={question?.helpText ?? ''} />
        </label>
        <label className="field field-12 q-options">
          <span>Seçenekler (JSON)</span>
          <textarea name="options" defaultValue={formatOptions(question?.options)} spellCheck={false} />
          <span className="help-text">
            Yalnızca SELECT ve MULTI_SELECT tipleri için. Diğer tiplerde boş bırakılabilir.
          </span>
        </label>
      </div>
      <input type="hidden" name="isActive" value={String(question?.isActive ?? true)} />
    </>
  );
}

function formatOptions(options: QuestionOption[] | null | undefined) {
  return options ? JSON.stringify(options, null, 2) : '';
}
