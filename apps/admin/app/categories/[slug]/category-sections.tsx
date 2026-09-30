import { CategoryImageUploader } from '../category-image-uploader';
import {
  CATEGORY_ICON_KEYS,
  type Category,
  type Question,
  type QuestionOption,
  type QuestionSystemField,
  type QuestionType,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import {
  CATEGORY_KINDS,
  CATEGORY_STATUSES,
  KIND_HINTS,
  KIND_LABELS,
  RELEASE_BLOCKER_HINTS,
  RELEASE_BLOCKER_LABELS,
  STATUS_HINTS,
  STATUS_LABELS,
  enrollmentSentence,
  type ReleaseBlocker,
} from '../category-taxonomy';

/**
 * The sections of one category's screen (#40), apart from the page that loads
 * them (ADMIN-DESIGN-001 Faz 3F).
 *
 * Every control here is the one the screen had before the redesign — same
 * fields, same names, same hidden inputs, same server action — and each is
 * drawn under exactly the condition it was drawn under before. The page
 * computes the permissions (`requireAdmin` → `can`) and passes booleans; the
 * actions come in as props so these sections render, and can be checked,
 * without a session. The API still checks every one of them.
 */

export type FormAction = (formData: FormData) => void | Promise<void>;

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

/**
 * The request field each binding stands in for, and the question type it has to
 * carry. Mirrors question-system-fields.ts in the API, which refuses anything
 * else — this is the same table, written so an admin can read it.
 */
const SYSTEM_FIELDS: { value: QuestionSystemField; label: string; type: QuestionType }[] = [
  { value: 'ADDRESS', label: 'Adres (il / ilçe / mahalle)', type: 'TEXT' },
  { value: 'BUDGET', label: 'Bütçe aralığı', type: 'NUMBER' },
  { value: 'DESCRIPTION', label: 'İş açıklaması', type: 'TEXTAREA' },
  { value: 'PREFERRED_DATE', label: 'Tercih edilen tarih', type: 'DATE' },
];

const SYSTEM_FIELD_LABELS: Record<QuestionSystemField, string> = {
  ADDRESS: 'Adres',
  BUDGET: 'Bütçe',
  DESCRIPTION: 'Açıklama',
  PREFERRED_DATE: 'Tarih',
};

// ---- Kategori bilgileri -----------------------------------------------------

/**
 * The category's own fields. With CATEGORIES_WRITE the edit form; without it
 * the same values, read-only.
 */
export function CategoryInfoSection({
  category,
  groups,
  canWrite,
  canChangeStatus,
  canUpload,
  updateAction,
}: {
  category: Category;
  /** The categories that may be its parent: groups other than itself. */
  groups: Category[];
  canWrite: boolean;
  canChangeStatus: boolean;
  canUpload: boolean;
  updateAction: FormAction;
}) {
  return (
    <SectionCard
      title="Kategori bilgileri"
      subtitle="Müşteri akışında görünen temel alanlar ve ağaçtaki yeri."
      testId="category-info-card"
    >
      {canWrite ? (
        <form action={updateAction} className="compact-form compact-form-wide">
          <input type="hidden" name="id" value={category.id} />
          <div className="compact-field-grid">
            <label className="field field-6">
              <span>Kategori adı *</span>
              <input name="name" required defaultValue={category.name} />
            </label>
            <label className="field field-6">
              <span>Kısa ad (slug) *</span>
              <input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={category.slug} />
            </label>
            <label className="field field-4">
              <span>Tip *</span>
              <select name="kind" defaultValue={category.kind}>
                {CATEGORY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              <span className="help-text">{KIND_HINTS[category.kind]}</span>
            </label>
            <label className="field field-4">
              <span>Durum *</span>
              {/*
                The status is its own permission (CATEGORIES_STATUS). Without
                it the select is shown but cannot be moved, and the save does
                not send a status at all (`statusLocked`): the API would refuse
                a status that differs from the stored one, and a stale page
                must not turn an ordinary edit into a 403. The current value
                still rides along as `status` because the payload's enrollment
                and eligibility rules read it.
              */}
              {canChangeStatus ? null : (
                <>
                  <input type="hidden" name="status" value={category.status} />
                  <input type="hidden" name="statusLocked" value="1" />
                </>
              )}
              <select
                name={canChangeStatus ? 'status' : undefined}
                defaultValue={category.status}
                disabled={!canChangeStatus}
              >
                {CATEGORY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
              <span className="help-text">{STATUS_HINTS[category.status]}</span>
            </label>
            <label className="field field-4">
              <span>Üst kategori</span>
              <select name="parentId" defaultValue={category.parentId ?? ''}>
                <option value="">— (üst seviye)</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <span className="help-text">Yalnızca grup tipindeki kategoriler üst kategori olabilir.</span>
            </label>
            <label className="field field-3">
              <span>Sıralama</span>
              <input name="sortOrder" type="number" min="0" defaultValue={category.sortOrder} />
            </label>
            {/*
              Editable on a draft service and nowhere else. A live service is
              always open to applications — closing one would refuse every
              profile save against it — so the box is shown ticked and
              disabled rather than hidden, because "why can I not change this"
              is a question the screen should answer where it is asked.
            */}
            <label className="field field-6">
              <span>Hizmet veren başvurusu</span>
              <input
                name="providerEnrollmentOpen"
                type="checkbox"
                data-testid="provider-enrollment-open"
                defaultChecked={
                  category.kind === 'LEAF' && (category.status === 'ACTIVE' || category.providerEnrollmentOpen)
                }
                disabled={!(category.kind === 'LEAF' && category.status === 'DRAFT')}
              />
              <span className="help-text">
                {category.kind !== 'LEAF'
                  ? 'Yalnızca hizmet tipindeki kategoriler için geçerlidir.'
                  : category.status === 'ACTIVE'
                    ? 'Yayındaki hizmetlerde başvuru her zaman açıktır.'
                    : category.status === 'INACTIVE'
                      ? 'Kapalı hizmetler başvuruya açılamaz.'
                      : 'Açıkken hizmet verenler bu taslak hizmeti kendi profillerine ekleyebilir. Müşteri tarafı kapalı kalır.'}
              </span>
            </label>
            {/*
              Whether this category may be sold as part of a "category
              unlimited" package. Off for everything until somebody turns it
              on, which is how regulated and high-value services stay out of
              unlimited packages without anybody maintaining a list.
            */}
            <label className="field field-6">
              <span>Limitsiz paket uygunluğu</span>
              <input
                name="unlimitedPackageEligible"
                type="checkbox"
                data-testid="unlimited-package-eligible"
                defaultChecked={category.unlimitedPackageEligible}
                disabled={category.status === 'INACTIVE'}
              />
              <span className="help-text">
                {category.status === 'INACTIVE'
                  ? 'Kapalı kategoriler limitsiz paket kapsamına alınamaz.'
                  : 'Açıkken bu kategori (ve grup seçilirse alt kategorileri) kategori limitsiz paketlerin kapsamına eklenebilir. Regüle veya yüksek değerli kategorilerde kapalı bırakın.'}
              </span>
            </label>
            <label className="field field-3">
              <span>Teklif kredisi{category.kind === 'LEAF' ? ' *' : ''}</span>
              <input
                name="offerCreditCost"
                type="number"
                min="1"
                step="1"
                required={category.kind === 'LEAF'}
                disabled={category.kind !== 'LEAF'}
                defaultValue={category.offerCreditCost ?? ''}
              />
              <span className="help-text">
                {category.kind === 'LEAF'
                  ? 'Yalnız bundan sonraki teklifleri etkiler; geçmiş teklif ve iadeleri değiştirmez.'
                  : 'Bu tipte teklif verilemediği için kredi maliyeti kullanılmaz.'}
              </span>
            </label>
            <label className="field field-12">
              <span>Açıklama</span>
              <textarea name="description" defaultValue={category.description ?? ''} />
            </label>
            <CategoryImageUploader
              canUpload={canUpload}
              name="imageUrl"
              label="Kart görseli"
              variant="card"
              defaultValue={category.imageUrl ?? ''}
              helpText="Kategoriler listesindeki kart için kullanılır."
            />
            <CategoryImageUploader
              canUpload={canUpload}
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
                Görsel verilmediğinde kullanılacak ikon. Boş bırakılırsa kategori adına göre otomatik fallback
                ikon kullanılır.
              </span>
            </label>
          </div>
          <div className="compact-actions">
            <button className="btn btn-primary btn-sm" type="submit">
              Kategoriyi kaydet
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Kısa ad değişirse mevcut bağlantılar kırılır.
            </span>
          </div>
        </form>
      ) : (
        <CategoryReadOnlyDetails category={category} />
      )}
    </SectionCard>
  );
}

/**
 * What the category form shows, for a session that may read it but not save it.
 * The header above already carries name, slug, type, status, parent and order.
 */
function CategoryReadOnlyDetails({ category }: { category: Category }) {
  return (
    <div className="catalog-readonly" data-testid="category-read-only">
      <KeyValueList
        items={[
          { label: 'Kategori adı', value: category.name },
          { label: 'Kısa ad', value: <code className="cell-break">{category.slug}</code> },
          {
            label: 'Teklif kredisi',
            value: category.kind === 'LEAF' ? (category.offerCreditCost ?? '—') : '—',
          },
          {
            label: 'Hizmet veren başvurusu',
            value:
              category.kind !== 'LEAF'
                ? '—'
                : category.status === 'ACTIVE' || category.providerEnrollmentOpen
                  ? 'Açık'
                  : 'Kapalı',
          },
          { label: 'Limitsiz paket uygunluğu', value: category.unlimitedPackageEligible ? 'Açık' : 'Kapalı' },
          { label: 'Fallback ikon anahtarı', value: category.iconKey ?? '—' },
          { label: 'Açıklama', value: category.description ?? '—' },
          {
            label: 'Kart görseli',
            value: category.imageUrl ? (
              <img src={category.imageUrl} alt="Kart görseli" className="cat-visual-preview-card" />
            ) : (
              '—'
            ),
          },
          {
            label: 'Kapak görseli',
            value: category.coverImageUrl ? (
              <img src={category.coverImageUrl} alt="Kapak görseli" className="cat-visual-preview-cover" />
            ) : (
              '—'
            ),
          },
        ]}
      />
    </div>
  );
}

// ---- Yönlendirme hedefleri ------------------------------------------------------

/**
 * A router's option → service map. Only on a ROUTER, and only for a session
 * that may read questions (the router question is one of them).
 */
export function RouterTargetsSection({
  categorySlug,
  routerQuestion,
  targets,
  canWriteQuestions,
  replaceRulesAction,
}: {
  categorySlug: string;
  routerQuestion: Question | undefined;
  /** Services and other routers; never a group, never itself. */
  targets: Category[];
  canWriteQuestions: boolean;
  replaceRulesAction: FormAction;
}) {
  return (
    <SectionCard
      title="Yönlendirme hedefleri"
      subtitle="Yönlendirme sorusunun her seçeneği hangi hizmete gider."
      testId="router-targets-card"
    >
      {routerQuestion && !canWriteQuestions ? (
        <RouterRulesReadOnly question={routerQuestion} targets={targets} />
      ) : routerQuestion ? (
        <form action={replaceRulesAction} className="compact-form compact-form-wide">
          <input type="hidden" name="id" value={routerQuestion.id} />
          <input type="hidden" name="categorySlug" value={categorySlug} />
          <p className="help-text" style={{ margin: 0 }}>
            Yönlendirme sorusu: <strong>{routerQuestion.label}</strong>. Hedefi boş bırakılan seçenek kaydedilmez ve
            müşteriyi hiçbir yere taşımaz.
          </p>
          <div className="compact-field-grid">
            {(routerQuestion.options ?? []).map((option) => {
              const existing = (routerQuestion.routerRules ?? []).find((rule) => rule.optionKey === option.key);

              return (
                <label className="field field-12" key={option.key}>
                  <span>{option.label}</span>
                  <input type="hidden" name="routerOptionKey" value={option.key} />
                  <select name="routerTargetSlug" defaultValue={existing?.targetCategorySlug ?? ''}>
                    <option value="">— (hedef yok)</option>
                    {targets.map((target) => (
                      <option key={target.id} value={target.slug}>
                        {target.name} · {KIND_LABELS[target.kind]} · {STATUS_LABELS[target.status]}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
          <div className="compact-actions">
            <button className="btn btn-primary btn-sm" type="submit">
              Yönlendirmeyi kaydet
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Hedef yayında bir hizmet değilse müşteri talebi tamamlayamaz.
            </span>
          </div>
        </form>
      ) : (
        <EmptyState
          title="Yönlendirme sorusu yok."
          description={
            canWriteQuestions
              ? 'Aşağıdan SELECT tipinde bir soru ekleyip “Yönlendirme sorusu” alanını Evet yapın.'
              : undefined
          }
        />
      )}
    </SectionCard>
  );
}

/** The router's option → service map, for a session without QUESTIONS_WRITE. */
function RouterRulesReadOnly({ question, targets }: { question: Question; targets: Category[] }) {
  return (
    <div className="catalog-readonly" data-testid="router-rules-read-only">
      <p className="help-text" style={{ margin: '0 0 12px' }}>
        Yönlendirme sorusu: <strong>{question.label}</strong>.
      </p>
      <KeyValueList
        items={(question.options ?? []).map((option) => {
          const rule = (question.routerRules ?? []).find((entry) => entry.optionKey === option.key);
          const target = rule ? targets.find((candidate) => candidate.slug === rule.targetCategorySlug) : undefined;
          return {
            label: option.label,
            value: rule ? (target?.name ?? rule.targetCategorySlug) : '— (hedef yok)',
          };
        })}
      />
    </div>
  );
}

// ---- Soru seti --------------------------------------------------------------------

export type QuestionActions = {
  update: FormAction;
  replaceConditions: FormAction;
  updateStatus: FormAction;
  create: FormAction;
};

/**
 * The question set: one expandable row per question, and a create panel.
 *
 * With QUESTIONS_WRITE each row opens its edit form, its condition editor and
 * its activate/deactivate button, and the create panel is drawn; without it a
 * row opens the question's settings, read-only.
 */
export function QuestionSetSection({
  category,
  questions,
  isRouter,
  canWriteQuestions,
  actions,
}: {
  category: Category;
  /** Sorted by sort order, then label. */
  questions: Question[];
  isRouter: boolean;
  canWriteQuestions: boolean;
  actions: QuestionActions;
}) {
  return (
    <SectionCard
      title="Soru seti"
      subtitle="Bu kategori için müşteriye sorulacak dinamik sorular. Satırı açarak düzenleyin; yeni soruyu en alttan ekleyin."
      padded={false}
      testId="question-set-card"
    >
      <div className="question-manager">
        {questions.length === 0 ? (
          <EmptyState
            title="Bu kategoride soru yok."
            description={canWriteQuestions ? 'Aşağıdaki “+ Yeni Soru Ekle” ile başlayabilirsiniz.' : undefined}
          />
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
            {questions.map((question) => (
              <details className="question-row" key={question.id}>
                <summary>
                  <span className="q-order">{question.sortOrder}</span>
                  <span className="q-label">
                    {question.label}
                    {question.systemField ? (
                      <span
                        className="meta-pill"
                        style={{ marginLeft: 8 }}
                        title="Bu soru talebin kendi alanına bağlı; cevap olarak ikinci kez saklanmaz."
                      >
                        {SYSTEM_FIELD_LABELS[question.systemField]} alanı
                      </span>
                    ) : null}
                    {question.isRouter ? (
                      <span className="meta-pill" style={{ marginLeft: 8 }}>
                        yönlendirme
                      </span>
                    ) : null}
                    {(question.conditions ?? []).length > 0 ? (
                      <span className="meta-pill" style={{ marginLeft: 8 }}>
                        koşullu · {question.conditions?.[0]?.matchMode === 'ALL' ? 'tamamı' : 'herhangi biri'}
                      </span>
                    ) : null}
                  </span>
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
                    <span className={question.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                      {question.isActive ? 'Aktif' : 'Pasif'}
                    </span>
                  </span>
                  <span className="q-action">{canWriteQuestions ? 'Düzenle' : 'Görüntüle'}</span>
                </summary>
                {canWriteQuestions ? (
                  <div className="question-edit-panel">
                    <form action={actions.update} className="compact-form compact-form-wide">
                      <input type="hidden" name="id" value={question.id} />
                      <input type="hidden" name="categorySlug" value={category.slug} />
                      <QuestionFields question={question} allowRouter={isRouter} />
                      <div className="panel-footer">
                        <button className="btn btn-primary btn-sm" type="submit">
                          Soruyu kaydet
                        </button>
                      </div>
                    </form>

                    <ConditionEditor
                      question={question}
                      categorySlug={category.slug}
                      siblings={questions}
                      action={actions.replaceConditions}
                    />

                    <form
                      action={actions.updateStatus}
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
                        className={question.isActive ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'}
                        type="submit"
                      >
                        {question.isActive ? 'Pasifleştir' : 'Aktifleştir'}
                      </button>
                    </form>
                  </div>
                ) : (
                  <div className="question-edit-panel">
                    <QuestionReadOnlyDetails question={question} />
                  </div>
                )}
              </details>
            ))}
          </div>
        )}

        {canWriteQuestions ? (
          <details className="question-create-panel">
            <summary>Yeni Soru Ekle</summary>
            <div className="question-create-panel-body">
              <form action={actions.create} className="compact-form compact-form-wide">
                <input type="hidden" name="categoryId" value={category.id} />
                <input type="hidden" name="categorySlug" value={category.slug} />
                <QuestionFields allowRouter={isRouter} />
                <div className="compact-actions">
                  <button className="btn btn-primary btn-sm" type="submit">
                    Soruyu oluştur
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Oluşturulan soru varsayılan olarak aktif olur. Koşul ve yönlendirme hedefi soru kaydedildikten
                    sonra tanımlanır.
                  </span>
                </div>
              </form>
            </div>
          </details>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** One question's settings, for a session without QUESTIONS_WRITE. */
function QuestionReadOnlyDetails({ question }: { question: Question }) {
  const condition = (question.conditions ?? [])[0];

  return (
    <KeyValueList
      items={[
        {
          label: 'Sistem alanı bağı',
          value: question.systemField ? SYSTEM_FIELD_LABELS[question.systemField] : '—',
        },
        { label: 'Yardım metni', value: question.helpText ?? '—' },
        {
          label: 'Seçenekler',
          value:
            (question.options ?? []).length > 0
              ? (question.options ?? []).map((option) => option.label).join(', ')
              : '—',
        },
        {
          label: 'Koşul',
          value: condition
            ? `${condition.sourceQuestionKey}: ${condition.expectedValues.join(', ')} (${
                condition.matchMode === 'ALL' ? 'tamamı' : 'herhangi biri'
              })`
            : 'Her zaman görünür',
        },
      ]}
    />
  );
}

/**
 * The visibility rule for one question.
 *
 * One rule per question in this form on purpose: a single "shown when X is one
 * of these" is what the expansion actually needs, and it fits on a screen an
 * admin can read at a glance. The API accepts several ANDed rules, so a
 * second one is a form change rather than a data-model change.
 */
export function ConditionEditor({
  question,
  categorySlug,
  siblings,
  action,
}: {
  question: Question;
  categorySlug: string;
  siblings: Question[];
  action: FormAction;
}) {
  // Only an earlier SELECT/MULTI_SELECT question can be a source: that ordering
  // is what keeps the dependency graph acyclic, and the API refuses anything
  // else.
  const sources = siblings.filter(
    (candidate) =>
      candidate.id !== question.id &&
      candidate.sortOrder < question.sortOrder &&
      (candidate.type === 'SELECT' || candidate.type === 'MULTI_SELECT'),
  );

  const current = (question.conditions ?? [])[0];

  /*
   * Every candidate source's options in one list, grouped by question and
   * qualified with the source's key.
   *
   * A plain list of option keys would be ambiguous — two questions can both
   * offer `evet` — and rendering only the chosen source's options would need
   * either JavaScript or a first save that stores nothing. Qualifying the value
   * lets the whole rule be set and saved in one submission, with no script on
   * the page; the action keeps the entries whose prefix matches the chosen
   * source and drops the rest.
   */
  const qualify = (sourceKey: string, optionKey: string) => `${sourceKey}${'::'}${optionKey}`;

  /*
   * "Tamamı" is only offered when it could mean something.
   *
   * ANY and ALL differ only for a source the customer can give several answers
   * to; on a single-choice question they are the same test, and the API refuses
   * the distinction rather than storing one that changes nothing. Disabling the
   * option here says that on the screen instead of letting an admin pick it and
   * meet a 400.
   */
  const multiSelectSourceExists = sources.some((source) => source.type === 'MULTI_SELECT');

  return (
    <form action={action} className="compact-form compact-form-wide">
      <input type="hidden" name="id" value={question.id} />
      <input type="hidden" name="categorySlug" value={categorySlug} />
      <div className="compact-field-grid">
        <label className="field field-6">
          <span>Koşul: kaynak soru</span>
          <select name="sourceQuestionKey" defaultValue={current?.sourceQuestionKey ?? ''}>
            <option value="">— (her zaman görünsün)</option>
            {sources.map((source) => (
              <option key={source.id} value={source.key}>
                {source.label}
              </option>
            ))}
          </select>
          <span className="help-text">
            {sources.length === 0
              ? 'Bu sorudan önce sıralanmış bir seçim sorusu yok; koşul tanımlanamaz.'
              : 'Yalnızca bu sorudan önce sıralanan seçim soruları kaynak olabilir.'}
          </span>
        </label>
        <label className="field field-6">
          <span>Beklenen cevaplar</span>
          <select
            name="expectedValues"
            multiple
            defaultValue={(current?.expectedValues ?? []).map((value) =>
              qualify(current?.sourceQuestionKey ?? '', value),
            )}
          >
            {sources.map((source) => (
              <optgroup key={source.id} label={source.label}>
                {(source.options ?? []).map((option) => (
                  <option key={option.key} value={qualify(source.key, option.key)}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="help-text">
            Kaynak sorunun seçeneklerini işaretleyin. Başka bir sorunun altındaki seçenekler yok sayılır.
          </span>
        </label>
        <label className="field field-12">
          <span>Eşleşme kuralı</span>
          <select name="matchMode" defaultValue={current?.matchMode ?? 'ANY'}>
            <option value="ANY">Herhangi biri — işaretlenen cevaplardan en az biri seçilirse görünür</option>
            <option value="ALL" disabled={!multiSelectSourceExists}>
              Tamamı — işaretlenen cevapların hepsi seçilirse görünür
            </option>
          </select>
          <span className="help-text">
            {multiSelectSourceExists
              ? 'İkisi yalnızca çok seçimli bir kaynak soruda farklıdır; tek seçimli soruda “tamamı” kabul edilmez.'
              : 'Bu sorunun kaynak adaylarının hiçbiri çok seçimli değil; yalnızca “herhangi biri” kullanılabilir.'}
          </span>
        </label>
      </div>
      <div className="compact-actions">
        <button className="btn btn-secondary btn-sm" type="submit">
          Koşulu kaydet
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Koşul sağlanmadığında soru müşteriye gösterilmez ve cevabı kabul edilmez.
        </span>
      </div>
    </form>
  );
}

function QuestionFields({ question, allowRouter }: { question?: Question; allowRouter: boolean }) {
  return (
    <>
      <div className="compact-field-grid">
        <label className="field field-6">
          <span>Key</span>
          <input name="key" required pattern="[a-z0-9]+([_-][a-z0-9]+)*" defaultValue={question?.key ?? ''} />
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
          <input name="sortOrder" type="number" min="0" defaultValue={question?.sortOrder ?? 0} />
        </label>
        <label className="field field-6">
          <span>Sistem alanı bağı</span>
          <select name="systemField" defaultValue={question?.systemField ?? ''}>
            <option value="">— (normal soru)</option>
            {SYSTEM_FIELDS.map((field) => (
              <option key={field.value} value={field.value}>
                {field.label} · {field.type}
              </option>
            ))}
          </select>
          <span className="help-text">
            Bağlı soru yeni bir alan açmaz: talebin mevcut alanını adlandırır ve zorunlu kılabilir. Soru tipi
            listedeki tiple aynı olmalıdır.
          </span>
        </label>
        <label className="field field-6">
          <span>Yönlendirme sorusu</span>
          <select name="isRouter" defaultValue={String(question?.isRouter ?? false)} disabled={!allowRouter}>
            <option value="false">Hayır</option>
            <option value="true">Evet</option>
          </select>
          <span className="help-text">
            {allowRouter
              ? 'Kategori başına yalnız bir yönlendirme sorusu olabilir ve SELECT tipinde olmalıdır.'
              : 'Yalnızca yönlendirici tipindeki kategorilerde kullanılabilir.'}
          </span>
        </label>
        <label className="field field-12">
          <span>Yardım metni</span>
          <input name="helpText" defaultValue={question?.helpText ?? ''} />
        </label>
        <label className="field field-12 q-options">
          <span>Seçenekler (JSON)</span>
          <textarea name="options" defaultValue={formatOptions(question?.options)} spellCheck={false} />
          <span className="help-text">Yalnızca SELECT ve MULTI_SELECT tipleri için. Diğer tiplerde boş bırakılabilir.</span>
        </label>
      </div>
      <input type="hidden" name="isActive" value={String(question?.isActive ?? true)} />
      {/*
        A disabled control posts nothing, so a non-router category would submit
        an absent field and the payload would read it as "false" — which is what
        it must be. Stated rather than relied on.
      */}
      {allowRouter ? null : <input type="hidden" name="isRouter" value="false" />}
    </>
  );
}

function formatOptions(options: QuestionOption[] | null | undefined) {
  return options ? JSON.stringify(options, null, 2) : '';
}

// ---- Yan sütun ----------------------------------------------------------------------

/** The status switch, with CATEGORIES_STATUS only. */
export function CategoryStatusSection({ category, action }: { category: Category; action: FormAction }) {
  return (
    <SectionCard
      title="Kategori durumu"
      subtitle={STATUS_HINTS[category.status]}
      className={category.status === 'ACTIVE' ? 'catalog-side-card is-warning' : 'catalog-side-card'}
      testId="category-status-panel"
    >
      <form action={action} className="catalog-side-form">
        <input type="hidden" name="id" value={category.id} />
        <input type="hidden" name="slug" value={category.slug} />
        <label className="detail-form-field">
          <span>Yeni durum</span>
          <select name="status" defaultValue={category.status}>
            {CATEGORY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary btn-sm" type="submit">
          Durumu güncelle
        </button>
      </form>
    </SectionCard>
  );
}

/**
 * Why a draft is not on the catalogue, and the release checklist — the same
 * three rules the list's "Yayına hazır mı?" reads. Only on a draft; the
 * checklist itself only on a service.
 */
export function ReleaseChecklistSection({
  category,
  blockers,
  questionCount,
}: {
  category: Category;
  blockers: ReleaseBlocker[];
  /** `null` without QUESTIONS_READ: the row is then not drawn. */
  questionCount: number | null;
}) {
  const approvedProviders = category._count?.providers ?? 0;
  const activeInvites = category._count?.providerInvites ?? 0;
  const enrollment = enrollmentSentence(category);

  return (
    <SectionCard
      title="Bu kategori neden yayında değil?"
      className="catalog-side-card"
      testId="draft-explainer"
    >
      <div className="catalog-side-body">
        <p>
          Taslak kategoriler yalnızca bu panelde görünür. Müşteri kataloğunda listelenmez, hizmet verenlerin keşif
          ekranına düşmez ve seçilebilir hizmet listesine eklenemez.
        </p>
        <p className="catalog-side-note">
          Yayına almadan önce şunları kontrol edin: soru seti tamam mı, zorunlu alanlar doğru mu, hizmet tipindeyse
          teklif kredisi tanımlı mı? Hazır olduğunda durumu <strong>{STATUS_LABELS.ACTIVE}</strong> yapmanız yeterli.
        </p>

        {category.kind === 'LEAF' ? (
          <dl className="release-checklist" data-testid="release-checklist">
            <div>
              <dt>Teklif kredisi</dt>
              <dd>
                {category.offerCreditCost === null ? (
                  <span className="badge badge-bad" title={RELEASE_BLOCKER_HINTS.NO_PRICE}>
                    {RELEASE_BLOCKER_LABELS.NO_PRICE}
                  </span>
                ) : (
                  <strong>{category.offerCreditCost}</strong>
                )}
              </dd>
            </div>
            <div>
              <dt>Onaylı hizmet veren</dt>
              <dd>
                {approvedProviders === 0 ? (
                  <span className="badge badge-bad" title={RELEASE_BLOCKER_HINTS.NO_APPROVED_PROVIDER}>
                    0
                  </span>
                ) : (
                  <strong>{approvedProviders}</strong>
                )}
              </dd>
            </div>
            {questionCount !== null ? (
              <div>
                <dt>Soru sayısı</dt>
                <dd>
                  <strong>{questionCount}</strong>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Geçerli davet</dt>
              <dd data-testid="release-active-invites">
                {/*
                  Shown next to the blockers and deliberately not one of them.
                  A live invitation means a business has been approached, which
                  is progress towards supply and not supply: until one of them
                  applies and is approved, the approved-provider figure above is
                  still zero and this service is still not ready.
                */}
                <strong>{activeInvites}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {' '}
                  · hazır sayılmaz
                </span>
              </dd>
            </div>
            <div>
              <dt>Hizmet veren başvurusu</dt>
              <dd data-testid="enrollment-note">
                {/*
                  "Nobody has applied" and "nobody may apply" look identical in
                  the count above and are entirely different problems. This row
                  is the one that tells them apart.
                */}
                {category.providerEnrollmentOpen ? (
                  <span className="badge badge-good">Başvuruya açık</span>
                ) : (
                  <span className="badge badge-muted">Yeni hizmet veren başvurusu kapalı</span>
                )}
                {enrollment ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {' '}
                    · {enrollment}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Yayına hazır mı?</dt>
              <dd>
                {blockers.length === 0 ? (
                  <span className="badge badge-good">Hazır</span>
                ) : (
                  <span className="badge badge-warn">Hazır değil</span>
                )}
              </dd>
            </div>
          </dl>
        ) : null}

        {blockers.length > 0 ? (
          <ul className="release-blocker-reasons" data-testid="release-blockers">
            {blockers.map((blocker) => (
              <li data-testid={`release-blocker-${blocker}`} key={blocker}>
                <strong>{RELEASE_BLOCKER_LABELS[blocker]}.</strong> {RELEASE_BLOCKER_HINTS[blocker]}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** What a router is and is not, on a router. */
export function RouterExplainerSection() {
  return (
    <SectionCard title="Yönlendirici kategori" className="catalog-side-card is-warning" testId="router-explainer">
      <div className="catalog-side-body">
        <p>
          Bu kategori <strong>hizmet verene doğrudan atanamaz</strong>. Hizmet veren kayıt ve düzenleme ekranlarında
          seçilemez, keşif listesinde çıkmaz ve üzerine teklif verilemez.
        </p>
        <p className="catalog-side-note">
          Müşteri buradaki soruyu yanıtlar, sunucu cevabı yönlendirme kuralında arar ve talebi gerçek hizmet
          kategorisine taşır. Eşleştirme, teklif kredisi ve iş kapsamı yalnız o hizmet üzerinden çalışır.
        </p>
      </div>
    </SectionCard>
  );
}

/** The question set's rules of thumb (the old "Hızlı bilgi" panel). */
export function QuestionHintsSection() {
  return (
    <SectionCard title="Hızlı bilgi" className="catalog-side-card">
      <div className="catalog-side-body">
        <p>
          Soru sırası müşteri formundaki gösterim sırasını belirler. SELECT ve MULTI_SELECT tiplerinde{' '}
          <code>options</code> JSON alanı zorunludur.
        </p>
        <p className="catalog-side-note">
          Koşullu bir soru, kaynak sorudan <strong>sonra</strong> sıralanmalıdır. Sistem alanına bağlı sorular ayrı bir
          alan açmaz; talebin adres, bütçe, açıklama veya tarih alanını adlandırır ve gerektiğinde zorunlu kılar.
        </p>
      </div>
    </SectionCard>
  );
}
