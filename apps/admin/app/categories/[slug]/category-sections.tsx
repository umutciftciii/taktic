import Link from 'next/link';
import type { ReactNode } from 'react';
import { CategoryImageUploader } from '../category-image-uploader';
import type { CategoryPlacementImpact } from '../category-changes';
import { CategoryEditSubmit, CategoryStatusSubmit, RouterRulesSubmit } from '../category-gates';
import {
  CATEGORY_ICON_KEYS,
  formatDateTime,
  type Category,
  type Question,
  type QuestionOption,
  type QuestionSystemField,
  type QuestionType,
} from '../../../lib/api';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DetailFormFooter } from '../../../components/detail-form-footer';
import { EmptyState } from '../../../components/empty-state';
import { InfoPopover } from '../../../components/info-popover';
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
  placementImpact = null,
  slugChangeHref = null,
  publiclyReachable = false,
}: {
  category: Category;
  /** The categories that may be its parent: groups other than itself. */
  groups: Category[];
  canWrite: boolean;
  canChangeStatus: boolean;
  canUpload: boolean;
  updateAction: FormAction;
  /** The vitrin runs a status move would touch, for the save's dialog; null when not countable. */
  placementImpact?: CategoryPlacementImpact;
  /**
   * SEO-004 PR B: the address window (`/seo/slugs?kategori=…`), for a session
   * that may open and save it; null otherwise. The form itself no longer sends
   * a slug — the window is the one way to change it.
   */
  slugChangeHref?: string | null;
  /** Whether the category is public now: a change of its address then writes a 301. */
  publiclyReachable?: boolean;
}) {
  return (
    <SectionCard
      title="Kategori bilgileri"
      actions={
        <span className="section-card-meta">
          {category.updatedAt
            ? `Son değişiklik: ${formatDateTime(category.updatedAt)}`
            : 'Müşteri akışında görünen alanlar ve ağaçtaki yeri'}
        </span>
      }
      className="detail-tab-card"
      testId="category-info-card"
    >
      {canWrite ? (
        <form action={updateAction} className="compact-form compact-form-wide">
          <input type="hidden" name="id" value={category.id} />
          <div className="compact-field-grid">
            <label className="field field-4">
              <span>Kategori adı *</span>
              <input name="name" required defaultValue={category.name} />
            </label>
            {/*
              SEO-004 PR B: read-only. The address changes only in the SEO
              slug window, through the one server-side slug lifecycle (a public
              category gets its mandatory 301 in the same transaction). The form
              sends no slug, so a save here can never move it.
            */}
            <div className="field field-4" data-testid="category-slug-field">
              <span>Adres (kısa ad)</span>
              <div className="locked-field seo-slug-locked">
                <code className="locked-field-value cell-break" data-testid="category-slug-value">
                  /categories/{category.slug}
                </code>
                {slugChangeHref ? (
                  <Link className="btn btn-link btn-sm" href={slugChangeHref} scroll={false} data-testid="category-slug-change">
                    Adresi değiştir
                  </Link>
                ) : null}
              </div>
              <span className="help-text" data-testid="category-slug-help">
                {publiclyReachable
                  ? 'Adres değiştiğinde eski adres otomatik olarak yeni adrese 301 ile yönlendirilir.'
                  : 'Kategori herkese açık değil; adres değişirse yönlendirme oluşturulmaz.'}
                {slugChangeHref ? null : ' Adresi değiştirmek için kategori yazma ve SEO okuma yetkisi gerekir.'}
              </span>
            </div>
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
                  ? 'Hizmet verenin bu kategoride bir teklif vermesi kaç krediye mal olur. Yalnız bundan sonraki teklifleri etkiler; geçmiş teklif ve iadeleri değiştirmez.'
                  : 'Bu tipte teklif verilemediği için kredi maliyeti kullanılmaz.'}
              </span>
            </label>
            <label className="field field-4">
              <span>Sıralama</span>
              <input name="sortOrder" type="number" min="0" defaultValue={category.sortOrder} />
              <span className="help-text">Küçük sayı katalogda önce görünür.</span>
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
            {/*
              Editable on a draft service and nowhere else. A live service is
              always open to applications — closing one would refuse every
              profile save against it — so the box is shown ticked and
              disabled rather than hidden, because "why can I not change this"
              is a question the screen should answer where it is asked.
            */}
            <label className="field field-4">
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
            <label className="field field-4">
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
          <DetailFormFooter note="Teklif kredisi değişikliği yalnız bundan sonra verilecek tekliflerde geçerlidir. Adres bu formdan değişmez.">
            {/*
              Asks first when the save moves the type or parent, the
              offer price, switches unlimited eligibility on or moves the
              status (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B); the action
              judges the same against the stored category.
            */}
            <CategoryEditSubmit
              stored={category}
              parentNames={Object.fromEntries(groups.map((group) => [group.id, group.name]))}
              impact={placementImpact}
            />
          </DetailFormFooter>
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
      actions={<span className="section-card-meta">Yönlendirme sorusunun her seçeneği hangi hizmete gider</span>}
      className="detail-tab-card"
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
          <DetailFormFooter note="Hedef yayında bir hizmet değilse müşteri talebi tamamlayamaz.">
            {/* Asks first when any option is sent somewhere else (Paket B). */}
            <RouterRulesSubmit
              stored={routerQuestion.routerRules ?? []}
              optionLabels={Object.fromEntries((routerQuestion.options ?? []).map((option) => [option.key, option.label]))}
              targetNames={Object.fromEntries(targets.map((target) => [target.slug, target.name]))}
            />
          </DetailFormFooter>
        </form>
      ) : (
        <EmptyState
          title="Yönlendirme sorusu yok."
          description={
            canWriteQuestions
              ? 'Soru listesinin altından SELECT tipinde bir soru ekleyip “Yönlendirme sorusu” alanını Evet yapın.'
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
  const activeCount = questions.filter((question) => question.isActive).length;

  return (
    <SectionCard
      title={
        <>
          Talep formundaki sorular
          <InfoPopover label="Sorular nasıl çalışır?" size="sm">
            <QuestionHints />
          </InfoPopover>
        </>
      }
      actions={
        <span className="section-card-meta" data-testid="question-set-count">
          {questions.length} soru · {activeCount} aktif
        </span>
      }
      padded={false}
      className="detail-tab-card"
      testId="question-set-card"
    >
      <div className="question-manager">
        {questions.length === 0 ? (
          <EmptyState
            title="Bu kategoride soru yok."
            description={canWriteQuestions ? 'Aşağıdaki “Yeni soru ekle” ile başlayabilirsiniz.' : undefined}
          />
        ) : (
          <div className="question-table">
            <div className="question-table-head" aria-hidden="true">
              <span>Sıra</span>
              <span>Soru</span>
              <span>Cevap tipi</span>
              <span>Zorunlu</span>
              <span>Ne zaman sorulur</span>
              <span>Durum</span>
              <span>İşlem</span>
            </div>
            {questions.map((question) => (
              <details className="question-row" key={question.id}>
                <summary>
                  <span className="q-order">{question.sortOrder}</span>
                  <span className="q-label">
                    <span className="q-label-text">{question.label}</span>
                    <span className="q-sub q-key">
                      <code>{question.key}</code>
                      {question.systemField ? (
                        <span
                          className="meta-pill"
                          title="Bu soru talebin kendi alanına bağlı; cevap olarak ikinci kez saklanmaz."
                        >
                          {SYSTEM_FIELD_LABELS[question.systemField]} alanı
                        </span>
                      ) : null}
                      {question.isRouter ? <span className="meta-pill">yönlendirme</span> : null}
                    </span>
                  </span>
                  <span className="q-type">
                    <span>{QUESTION_TYPE_LABELS[question.type] ?? question.type}</span>
                    {optionCountNote(question) ? <span className="q-sub">{optionCountNote(question)}</span> : null}
                  </span>
                  <span className="q-required">{question.isRequired ? 'Evet' : 'Hayır'}</span>
                  <QuestionWhen question={question} siblings={questions} />
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
                      {question.isActive ? (
                        // Asks first: the question leaves every new request
                        // form (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B).
                        <ConfirmDialog
                          proof="question.deactivate"
                          triggerLabel="Pasifleştir"
                          triggerClassName="btn btn-danger btn-sm"
                          title="Soru pasifleştirilsin mi?"
                          consequence={<QuestionDeactivateConsequence question={question} />}
                          confirmLabel="Evet, pasifleştir"
                          testId={`question-deactivate-${question.id}`}
                        />
                      ) : (
                        <button className="btn btn-secondary btn-sm" type="submit">
                          Aktifleştir
                        </button>
                      )}
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
            <summary>Yeni soru ekle</summary>
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

/**
 * What "Pasifleştir" does (`PATCH /questions/:id/status`, `isActive: false`):
 * a soft switch, not a delete — the row, its answers and its rules stay, and
 * "Aktifleştir" puts it back.
 */
function QuestionDeactivateConsequence({ question }: { question: Question }) {
  return (
    <ul data-testid="question-disable-impact">
      <li>
        <strong>Soru silinmez, pasif olur.</strong> Kaydı, geçmiş taleplerdeki cevapları ve kuralları korunur; “Aktifleştir”
        ile geri açılabilir.
      </li>
      <li>
        <strong>Yeni akışlarda kullanılmaz:</strong> bundan sonra açılan taleplerin formunda sorulmaz.
      </li>
      {question.isRouter ? (
        <li>
          <strong>Bu yönlendirme sorusudur:</strong> pasifken yönlendirici kategorinin akışı durur; müşteriler bu sorudan bir hizmete taşınamaz.
        </li>
      ) : null}
    </ul>
  );
}

/** The design's "Cevap tipi" column, in words; the edit form keeps the type codes. */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  TEXT: 'Kısa metin',
  TEXTAREA: 'Serbest metin',
  SELECT: 'Tek seçim',
  MULTI_SELECT: 'Çoklu seçim',
  NUMBER: 'Sayı',
  BOOLEAN: 'Evet / Hayır',
  DATE: 'Tarih',
  IMAGE: 'Fotoğraf',
};

function optionCountNote(question: Question): string | null {
  if (question.type !== 'SELECT' && question.type !== 'MULTI_SELECT') return null;
  const count = (question.options ?? []).length;
  return `${count} seçenek`;
}

/**
 * "Ne zaman sorulur": always, or when the source question is answered with one
 * (or, for a "tamamı" rule, all) of the expected options — named by their
 * labels, read from the source question on this same screen. A source or an
 * option that is no longer there falls back to its key rather than vanishing.
 */
export function describeQuestionCondition(
  question: Question,
  siblings: Question[],
): { when: string; source: string | null } {
  const condition = (question.conditions ?? [])[0];
  if (!condition || condition.expectedValues.length === 0) return { when: 'Her zaman', source: null };

  const source = siblings.find((candidate) => candidate.key === condition.sourceQuestionKey);
  const labels = condition.expectedValues.map((value) => {
    const option = (source?.options ?? []).find((candidate) => candidate.key === value);
    return `"${option?.label ?? value}"`;
  });
  const joiner = condition.matchMode === 'ALL' ? ' ve ' : ' veya ';

  return {
    when: `${labels.join(joiner)} seçilirse`,
    source: source?.label ?? condition.sourceQuestionLabel ?? condition.sourceQuestionKey,
  };
}

function QuestionWhen({ question, siblings }: { question: Question; siblings: Question[] }) {
  const { when, source } = describeQuestionCondition(question, siblings);
  const condition = (question.conditions ?? [])[0];

  return (
    <span className="q-when">
      <span>{when}</span>
      {source ? (
        <span className="q-sub">
          <span className="meta-pill">
            koşullu · {condition?.matchMode === 'ALL' ? 'tamamı' : 'herhangi biri'}
          </span>
          <span>Kaynak: {source}</span>
        </span>
      ) : null}
    </span>
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

// ---- Kategori bilgileri sekmesinin alt kartları -----------------------------------

/**
 * The status switch, with CATEGORIES_STATUS only: the current status and what
 * it means, then the select and its button in the card's footer band.
 */
export function CategoryStatusSection({
  category,
  action,
  placementImpact = null,
}: {
  category: Category;
  action: FormAction;
  /** The vitrin runs the move would touch, for its dialog; null when not countable. */
  placementImpact?: CategoryPlacementImpact;
}) {
  return (
    <SectionCard
      title="Kategori durumu"
      padded={false}
      className={category.status === 'ACTIVE' ? 'detail-tab-card is-warning' : 'detail-tab-card'}
      testId="category-status-panel"
    >
      <div className="readiness-intro">
        <p>
          Şu anki durum: <strong>{STATUS_LABELS[category.status]}</strong>
        </p>
        <p className="catalog-side-note">{STATUS_HINTS[category.status]}</p>
      </div>
      <div className="detail-card-footer">
        <form action={action} className="detail-status-form">
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
          {/* Any move asks first, into ACTIVE or out of it (Paket B). */}
          <CategoryStatusSubmit stored={category} impact={placementImpact} />
        </form>
      </div>
    </SectionCard>
  );
}

/**
 * Why a draft is not on the catalogue, and the release checklist — the same
 * rules the list's "Yayına hazır mı?" reads. Only on a draft; the checklist
 * itself only on a service. Drawn as the design's ticked rows: a tick where
 * the rule is met, a warning where it blocks, a plain mark where the row is
 * information and not a rule (questions, invitations, enrollment).
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
  const isLeaf = category.kind === 'LEAF';

  return (
    <SectionCard
      title={isLeaf ? 'Yayına hazır mı?' : 'Bu kategori neden yayında değil?'}
      padded={false}
      className="detail-tab-card readiness-card"
      testId="draft-explainer"
    >
      <div className="readiness-intro">
        <p>
          Taslak kategoriler yalnızca bu panelde görünür. Müşteri kataloğunda listelenmez, hizmet verenlerin keşif
          ekranına düşmez ve seçilebilir hizmet listesine eklenemez.
        </p>
        <p className="catalog-side-note">
          Yayına almadan önce şunları kontrol edin: soru seti tamam mı, zorunlu alanlar doğru mu, hizmet tipindeyse
          teklif kredisi tanımlı mı? Hazır olduğunda durumu <strong>{STATUS_LABELS.ACTIVE}</strong> yapmanız yeterli.
        </p>
      </div>

      {isLeaf ? (
        <ul className="readiness-list" data-testid="release-checklist">
          <ReadinessRow
            tone={category.offerCreditCost === null ? 'warn' : 'ok'}
            label="Teklif kredisi"
            value={
              category.offerCreditCost === null ? (
                <span className="badge badge-bad" title={RELEASE_BLOCKER_HINTS.NO_PRICE}>
                  {RELEASE_BLOCKER_LABELS.NO_PRICE}
                </span>
              ) : (
                <strong>{category.offerCreditCost}</strong>
              )
            }
          />
          <ReadinessRow
            tone={approvedProviders === 0 ? 'warn' : 'ok'}
            label="Onaylı hizmet veren"
            value={
              approvedProviders === 0 ? (
                <span className="badge badge-bad" title={RELEASE_BLOCKER_HINTS.NO_APPROVED_PROVIDER}>
                  0
                </span>
              ) : (
                <strong>{approvedProviders}</strong>
              )
            }
          />
          {questionCount !== null ? (
            <ReadinessRow tone="info" label="Soru sayısı" value={<strong>{questionCount}</strong>} />
          ) : null}
          <ReadinessRow
            tone="info"
            label="Geçerli davet"
            /*
              Shown next to the blockers and deliberately not one of them. A
              live invitation means a business has been approached, which is
              progress towards supply and not supply: until one of them applies
              and is approved, the approved-provider figure above is still zero
              and this service is still not ready.
            */
            value={
              <span data-testid="release-active-invites">
                <strong>{activeInvites}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {' '}
                  · hazır sayılmaz
                </span>
              </span>
            }
          />
          <ReadinessRow
            tone="info"
            label="Hizmet veren başvurusu"
            /*
              "Nobody has applied" and "nobody may apply" look identical in the
              count above and are entirely different problems. This row is the
              one that tells them apart.
            */
            note={enrollment ?? undefined}
            value={
              <span data-testid="enrollment-note">
                {category.providerEnrollmentOpen ? (
                  <span className="badge badge-good">Başvuruya açık</span>
                ) : (
                  <span className="badge badge-muted">Yeni hizmet veren başvurusu kapalı</span>
                )}
              </span>
            }
          />
          <ReadinessRow
            tone={blockers.length === 0 ? 'ok' : 'warn'}
            label="Yayına hazır mı?"
            value={
              blockers.length === 0 ? (
                <span className="badge badge-good">Hazır</span>
              ) : (
                <span className="badge badge-warn">Hazır değil</span>
              )
            }
          />
        </ul>
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
    </SectionCard>
  );
}

const READINESS_MARKS = { ok: '✓', warn: '!', info: 'i' } as const;

function ReadinessRow({
  tone,
  label,
  note,
  value,
}: {
  tone: keyof typeof READINESS_MARKS;
  label: string;
  note?: string;
  value: ReactNode;
}) {
  return (
    <li>
      <span className={tone === 'ok' ? 'readiness-mark' : `readiness-mark is-${tone}`} aria-hidden="true">
        {READINESS_MARKS[tone]}
      </span>
      <span className="readiness-label">
        {label}
        {note ? <small>{note}</small> : null}
      </span>
      <span className="readiness-value">{value}</span>
    </li>
  );
}

/** What a router is and is not, on a router. */
export function RouterExplainerSection() {
  return (
    <SectionCard title="Yönlendirici kategori" className="detail-tab-card is-warning" testId="router-explainer">
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

/** The question set's rules of thumb (the old "Hızlı bilgi" panel), now the ⓘ beside the question card's title. */
export function QuestionHints() {
  return (
    <>
      Soru sırası müşteri formundaki gösterim sırasını belirler. SELECT ve MULTI_SELECT tiplerinde{' '}
      <code>options</code> JSON alanı zorunludur. Koşullu bir soru, kaynak sorudan <strong>sonra</strong>{' '}
      sıralanmalıdır. Sistem alanına bağlı sorular ayrı bir alan açmaz; talebin adres, bütçe, açıklama veya tarih
      alanını adlandırır ve gerektiğinde zorunlu kılar.
    </>
  );
}
