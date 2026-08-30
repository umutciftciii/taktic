import {
  createQuestionAction,
  replaceQuestionConditionsAction,
  replaceRouterRulesAction,
  updateCategoryAction,
  updateCategoryStatusAction,
  updateQuestionAction,
  updateQuestionStatusAction,
} from '../actions';
import { CategoryImageUploader } from '../category-image-uploader';
import { ProviderInvitePanel } from '../provider-invite-panel';
import {
  apiFetch,
  CATEGORY_ICON_KEYS,
  Category,
  ProviderInviteList,
  Question,
  QuestionOption,
  QuestionSystemField,
  QuestionType,
  requireAdmin,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { EmptyState } from '../../../components/empty-state';
import {
  CATEGORY_KINDS,
  CATEGORY_STATUSES,
  KIND_HINTS,
  KIND_LABELS,
  RELEASE_BLOCKER_HINTS,
  RELEASE_BLOCKER_LABELS,
  releaseBlockers,
  STATUS_HINTS,
  enrollmentSentence,
  STATUS_LABELS,
  SUPPLY_STATUS_LABELS,
  supplyStatusBadgeClass,
  statusBadgeClass,
} from '../category-taxonomy';

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

type CategoryDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function CategoryDetailPage({ params }: CategoryDetailPageProps) {
  await requireAdmin();
  const { slug } = await params;
  const category = await apiFetch<Category>(`/categories/${slug}?includeInactive=true`);
  const [questions, allCategories] = await Promise.all([
    apiFetch<Question[]>(`/categories/${category.id}/questions`),
    apiFetch<Category[]>('/categories?includeInactive=true'),
  ]);

  /*
   * The invitation history, but only for the categories that can have one.
   *
   * A group is a folder and a router is a question, so neither can be invited
   * to and the API refuses both — asking anyway would spend a request to be
   * told what the taxonomy already says. A closed service is refused for the
   * same reason, but its *past* invitations are still worth reading: they are
   * how an operator sees who was approached before the service was withdrawn.
   */
  const invitable = category.kind === 'LEAF';
  const invites = invitable
    ? await apiFetch<ProviderInviteList>(`/categories/${category.id}/provider-invites`)
    : null;

  const sortedQuestions = [...questions].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label, 'tr-TR');
  });

  const groups = allCategories.filter(
    (candidate) => candidate.kind === 'GROUP' && candidate.id !== category.id,
  );
  // A router may send the customer on to a service or to another router, never
  // to a group and never to itself. The picker offers exactly that.
  const routableTargets = allCategories.filter(
    (candidate) => candidate.kind !== 'GROUP' && candidate.id !== category.id,
  );

  const routerQuestion = sortedQuestions.find((question) => question.isRouter);
  const isRouter = category.kind === 'ROUTER';
  // The same two checks the release checklist on /categories runs, on the one
  // screen where somebody actually flips the status to ACTIVE.
  const blockers = releaseBlockers(category);
  const approvedProviders = category._count?.providers ?? 0;
  const activeInvites = category._count?.providerInvites ?? 0;

  return (
    <main className="categories-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Kategoriler', href: '/categories' },
          { label: category.name },
        ]}
        title={category.name}
        subtitle="Kategori bilgilerini, ağaçtaki yerini, durumunu ve müşteri formundaki soruları yönetin."
      />

      <div className="admin-meta-pills">
        <span className={statusBadgeClass(category.status)}>{STATUS_LABELS[category.status]}</span>
        <span className="meta-pill">{KIND_LABELS[category.kind]}</span>
        <span className="meta-pill">
          slug <code>{category.slug}</code>
        </span>
        {category.parent ? (
          <span className="meta-pill">üst: {category.parent.name}</span>
        ) : (
          <span className="meta-pill">üst seviye</span>
        )}
        <span className="meta-pill">{questions.length} soru</span>
        <span className="meta-pill">sıra {category.sortOrder}</span>
        {/*
          The supply reading, beside the publishing one and never instead of it.
          A LIVE service says "Yayında" in both, which is the point: a released
          category has an answer to "is it published" and the supply question is
          then somebody else's — the release checklist below still says whether
          anybody stands behind it.
        */}
        {category.supplyStatus ? (
          <span className={supplyStatusBadgeClass(category.supplyStatus)} data-testid="supply-status">
            {SUPPLY_STATUS_LABELS[category.supplyStatus]}
          </span>
        ) : null}
      </div>

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Kategori bilgileri"
            subtitle="Müşteri akışında görünen temel alanlar ve ağaçtaki yeri."
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
                  <select name="status" defaultValue={category.status}>
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
                  <span className="help-text">
                    Yalnızca grup tipindeki kategoriler üst kategori olabilir.
                  </span>
                </label>
                <label className="field field-3">
                  <span>Sıralama</span>
                  <input name="sortOrder" type="number" min="0" defaultValue={category.sortOrder} />
                </label>
                {/*
                  Editable on a draft service and nowhere else. A live service is
                  always open to applications — closing one would refuse every
                  profile save against it — so the box is shown ticked and
                  disabled rather than hidden, because "why can I not change
                  this" is a question the screen should answer where it is asked.
                */}
                <label className="field field-6">
                  <span>Hizmet veren başvurusu</span>
                  <input
                    name="providerEnrollmentOpen"
                    type="checkbox"
                    data-testid="provider-enrollment-open"
                    defaultChecked={
                      category.kind === 'LEAF' &&
                      (category.status === 'ACTIVE' || category.providerEnrollmentOpen)
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
                    otomatik fallback ikon kullanılır.
                  </span>
                </label>
              </div>
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

          {isRouter ? (
            <SectionCard
              title="Yönlendirme hedefleri"
              subtitle="Yönlendirme sorusunun her seçeneği hangi hizmete gider."
            >
              {routerQuestion ? (
                <form action={replaceRouterRulesAction} className="compact-form">
                  <input type="hidden" name="id" value={routerQuestion.id} />
                  <input type="hidden" name="categorySlug" value={category.slug} />
                  <p className="help-text" style={{ marginBottom: 12 }}>
                    Yönlendirme sorusu: <strong>{routerQuestion.label}</strong>. Hedefi boş bırakılan
                    seçenek kaydedilmez ve müşteriyi hiçbir yere taşımaz.
                  </p>
                  <div className="compact-field-grid">
                    {(routerQuestion.options ?? []).map((option) => {
                      const existing = (routerQuestion.routerRules ?? []).find(
                        (rule) => rule.optionKey === option.key,
                      );

                      return (
                        <label className="field field-12" key={option.key}>
                          <span>{option.label}</span>
                          <input type="hidden" name="routerOptionKey" value={option.key} />
                          <select
                            name="routerTargetSlug"
                            defaultValue={existing?.targetCategorySlug ?? ''}
                          >
                            <option value="">— (hedef yok)</option>
                            {routableTargets.map((target) => (
                              <option key={target.id} value={target.slug}>
                                {target.name} · {KIND_LABELS[target.kind]} ·{' '}
                                {STATUS_LABELS[target.status]}
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
                <div style={{ padding: 18 }}>
                  <EmptyState
                    title="Yönlendirme sorusu yok."
                    description="Aşağıdan SELECT tipinde bir soru ekleyip “Yönlendirme sorusu” alanını Evet yapın."
                  />
                </div>
              )}
            </SectionCard>
          ) : null}

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
                              koşullu ·{' '}
                              {question.conditions?.[0]?.matchMode === 'ALL'
                                ? 'tamamı'
                                : 'herhangi biri'}
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
                          siblings={sortedQuestions}
                        />

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
                    <QuestionFields allowRouter={isRouter} />
                    <div className="compact-actions">
                      <button className="btn btn-primary btn-sm" type="submit">
                        Soruyu oluştur
                      </button>
                      <span className="muted" style={{ fontSize: 12 }}>
                        Oluşturulan soru varsayılan olarak aktif olur. Koşul ve yönlendirme hedefi
                        soru kaydedildikten sonra tanımlanır.
                      </span>
                    </div>
                  </form>
                </div>
              </details>
            </div>
          </SectionCard>
        </div>

        <aside className="admin-side-column">
          <div
            className={
              category.status === 'ACTIVE' ? 'admin-action-panel is-warning' : 'admin-action-panel'
            }
          >
            <h3>Kategori durumu</h3>
            <p>{STATUS_HINTS[category.status]}</p>
            <form action={updateCategoryStatusAction} className="panel-row">
              <input type="hidden" name="id" value={category.id} />
              <input type="hidden" name="slug" value={category.slug} />
              <label className="field field-12">
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
          </div>

          {invites ? (
            <ProviderInvitePanel
              activeCount={invites.activeCount}
              canIssue={category.status !== 'INACTIVE'}
              categoryId={category.id}
              categoryName={category.name}
              categorySlug={category.slug}
              invites={invites.invites}
            />
          ) : null}

          {category.status === 'DRAFT' ? (
            <div className="admin-action-panel" data-testid="draft-explainer">
              <h3>Bu kategori neden yayında değil?</h3>
              <p>
                Taslak kategoriler yalnızca bu panelde görünür. Müşteri kataloğunda listelenmez,
                hizmet verenlerin keşif ekranına düşmez ve seçilebilir hizmet listesine eklenemez.
              </p>
              <p style={{ fontSize: 12 }}>
                Yayına almadan önce şunları kontrol edin: soru seti tamam mı, zorunlu alanlar doğru
                mu, hizmet tipindeyse teklif kredisi tanımlı mı? Hazır olduğunda durumu{' '}
                <strong>{STATUS_LABELS.ACTIVE}</strong> yapmanız yeterli.
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
                        <span
                          className="badge badge-bad"
                          title={RELEASE_BLOCKER_HINTS.NO_APPROVED_PROVIDER}
                        >
                          0
                        </span>
                      ) : (
                        <strong>{approvedProviders}</strong>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Soru sayısı</dt>
                    <dd>
                      <strong>{questions.length}</strong>
                    </dd>
                  </div>
                  <div>
                    <dt>Geçerli davet</dt>
                    <dd data-testid="release-active-invites">
                      {/*
                        Shown next to the blockers and deliberately not one of
                        them. A live invitation means a business has been
                        approached, which is progress towards supply and not
                        supply: until one of them applies and is approved, the
                        approved-provider figure above is still zero and this
                        service is still not ready.
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
                        "Nobody has applied" and "nobody may apply" look
                        identical in the count above and are entirely different
                        problems. This row is the one that tells them apart.
                      */}
                      {category.providerEnrollmentOpen ? (
                        <span className="badge badge-good">Başvuruya açık</span>
                      ) : (
                        <span className="badge badge-muted">
                          Yeni hizmet veren başvurusu kapalı
                        </span>
                      )}
                      {enrollmentSentence(category) ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {' '}
                          · {enrollmentSentence(category)}
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
                      <strong>{RELEASE_BLOCKER_LABELS[blocker]}.</strong>{' '}
                      {RELEASE_BLOCKER_HINTS[blocker]}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {isRouter ? (
            <div className="admin-action-panel is-warning" data-testid="router-explainer">
              <h3>Yönlendirici kategori</h3>
              <p>
                Bu kategori <strong>hizmet verene doğrudan atanamaz</strong>. Hizmet veren kayıt ve
                düzenleme ekranlarında seçilemez, keşif listesinde çıkmaz ve üzerine teklif verilemez.
              </p>
              <p style={{ fontSize: 12 }}>
                Müşteri buradaki soruyu yanıtlar, sunucu cevabı yönlendirme kuralında arar ve talebi
                gerçek hizmet kategorisine taşır. Eşleştirme, teklif kredisi ve iş kapsamı yalnız o
                hizmet üzerinden çalışır.
              </p>
            </div>
          ) : null}

          <div className="admin-action-panel">
            <h3>Hızlı bilgi</h3>
            <p>
              Soru sırası müşteri formundaki gösterim sırasını belirler. SELECT ve MULTI_SELECT
              tiplerinde <code>options</code> JSON alanı zorunludur.
            </p>
            <p style={{ fontSize: 12 }}>
              Koşullu bir soru, kaynak sorudan <strong>sonra</strong> sıralanmalıdır. Sistem alanına
              bağlı sorular ayrı bir alan açmaz; talebin adres, bütçe, açıklama veya tarih alanını
              adlandırır ve gerektiğinde zorunlu kılar.
            </p>
          </div>
        </aside>
      </div>
    </main>
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
function ConditionEditor({
  question,
  categorySlug,
  siblings,
}: {
  question: Question;
  categorySlug: string;
  siblings: Question[];
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
    <form action={replaceQuestionConditionsAction} className="compact-form compact-form-wide">
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
            Kaynak sorunun seçeneklerini işaretleyin. Başka bir sorunun altındaki seçenekler yok
            sayılır.
          </span>
        </label>
        <label className="field field-12">
          <span>Eşleşme kuralı</span>
          <select name="matchMode" defaultValue={current?.matchMode ?? 'ANY'}>
            <option value="ANY">
              Herhangi biri — işaretlenen cevaplardan en az biri seçilirse görünür
            </option>
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

function QuestionFields({
  question,
  allowRouter,
}: {
  question?: Question;
  allowRouter: boolean;
}) {
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
            Bağlı soru yeni bir alan açmaz: talebin mevcut alanını adlandırır ve zorunlu kılabilir.
            Soru tipi listedeki tiple aynı olmalıdır.
          </span>
        </label>
        <label className="field field-6">
          <span>Yönlendirme sorusu</span>
          <select
            name="isRouter"
            defaultValue={String(question?.isRouter ?? false)}
            disabled={!allowRouter}
          >
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
          <span className="help-text">
            Yalnızca SELECT ve MULTI_SELECT tipleri için. Diğer tiplerde boş bırakılabilir.
          </span>
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
