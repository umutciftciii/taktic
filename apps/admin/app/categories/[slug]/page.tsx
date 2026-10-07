import {
  createQuestionAction,
  replaceQuestionConditionsAction,
  replaceRouterRulesAction,
  updateCategoryAction,
  updateCategoryStatusAction,
  updateQuestionAction,
  updateQuestionStatusAction,
} from '../actions';
import { ProviderInvitePanel } from '../provider-invite-panel';
import {
  apiFetch,
  fetchOrNotFound,
  Category,
  formatDateTime,
  getCategoryHistory,
  ProviderInviteList,
  Question,
  requireAdmin,
  type ShowcasePlacement,
} from '../../../lib/api';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../../lib/confirmation-proof-keys';
import { rethrowNextControlFlow } from '../../../lib/next-control-flow';
import type { CategoryPlacementImpact } from '../category-changes';
import { formatCount } from '../../../lib/pagination';
import { parsePage, resolveTab } from '../../../lib/list-query';
import { ActivityLog } from '../../../components/activity-log';
import { AUDIT_SINCE_NOTE, AuditTimeline } from '../../../components/audit-timeline';
import { DetailHeader } from '../../../components/detail-header';
import type { SummaryItem } from '../../../components/summary-strip';
import { Tabs, type TabItem } from '../../../components/tabs';
import { inviteActivity } from './category-activity';
import { CategorySeoSection } from './category-seo-section';
import type { CategorySeoContent } from '../../../lib/seo';
import {
  KIND_HINTS,
  KIND_LABELS,
  RELEASE_BLOCKER_LABELS,
  releaseBlockers,
  STATUS_LABELS,
  SUPPLY_STATUS_LABELS,
  supplyStatusBadgeClass,
  statusBadgeClass,
} from '../category-taxonomy';
import {
  CategoryInfoSection,
  CategoryStatusSection,
  QuestionSetSection,
  ReleaseChecklistSection,
  RouterExplainerSection,
  RouterTargetsSection,
} from './category-sections';

/**
 * One category (#40), on the design's tabbed detail screen (ADMIN-DESIGN-001
 * Faz 3F.1): a way back to the list, the summary card — status, type and
 * supply badges, the slug and where it hangs, the name, and a strip with the
 * figures a release is decided on — then up to five tabs as links (`?tab=`):
 *
 * - Kategori bilgileri (the plain URL): the category form, then the cards that
 *   decide its status — the release checklist on a draft, the status desk and,
 *   on a router, what a router is.
 * - Sorular (QUESTIONS_READ): the routing map on a router and the question set.
 * - Hizmet veren davetleri (a service + PROVIDER_INVITES_READ): the desk.
 * - Arama motoru (SEO_READ; SEO-004 PR B): whether the public page is open to
 *   search engines and the rules it fails, with the API's own numbers, and the
 *   SEO content — saved with SEO_CONTENT_WRITE on its own route.
 * - Neler oldu: the category's change log (ADMIN-ACTION-AUDIT-001) — each
 *   create, edit and status move with its field diff and its operator — and,
 *   for a service, its invitations with who issued and who withdrew them.
 *   Question edits are not audited, and the tab says so.
 *
 * A tab the session may not read is not drawn, and asking for it by URL shows
 * the first tab. The question actions revalidate the page without a redirect,
 * so saving a question keeps the operator on Sorular.
 *
 * Nothing on this screen changed what it does. The inventory it was converted
 * against (plan belgesi, "Faz 3F envanter") lists every section and control
 * with the condition it is drawn under; each one is drawn under that same
 * condition here:
 *
 * - CATEGORIES_WRITE: the category form, otherwise its values read-only. The
 *   status select in it moves only with CATEGORIES_STATUS (`statusLocked`).
 *   The slug is not a field of it (SEO-004 PR B): "Adresi değiştir" opens the
 *   SEO slug window, offered with SEO_READ and CATEGORIES_WRITE.
 * - UPLOADS_WRITE: the upload buttons; the URL fields are part of the form.
 * - QUESTIONS_READ: the question set and, on a router, the routing map.
 *   QUESTIONS_WRITE on top of it: the edit forms, the condition editor, the
 *   activate/deactivate buttons and the create panel.
 * - CATEGORIES_STATUS: the status desk.
 * - PROVIDER_INVITES_READ on a service: the invitation desk; issuing needs
 *   PROVIDER_INVITES_ISSUE (and a category that is not closed), withdrawing
 *   PROVIDER_INVITES_REVOKE. The issued link is shown once, as before.
 * - A draft: why it is not on the catalogue, and the release checklist.
 *
 * Deleting a category or a question has an API route (CATEGORIES_DELETE,
 * QUESTIONS_DELETE) and no control here, on purpose (K9).
 */

type CategoryDetailPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; error?: string; gecmisSayfa?: string; adres?: string; yonlendirme?: string }>;
};

type TabKey = '' | 'sorular' | 'davetler' | 'arama-motoru' | 'gecmis';

export default async function CategoryDetailPage({ params, searchParams }: CategoryDetailPageProps) {
  const { can } = await requireAdmin('CATALOG_READ');
  const { slug } = await params;
  const { tab, error, gecmisSayfa, adres, yonlendirme } = await searchParams;
  // Each control below is offered only to a session the API would let through;
  // the API still checks every one of them.
  const canWriteCategory = can('CATEGORIES_WRITE');
  const canChangeStatus = can('CATEGORIES_STATUS');
  const canUpload = can('UPLOADS_WRITE');
  // The question set is a second read with its own permission. Without it the
  // page is the category, and the question sections are not rendered at all.
  const canReadQuestions = can('QUESTIONS_READ');
  const canWriteQuestions = canReadQuestions && can('QUESTIONS_WRITE');
  const canReadInvites = can('PROVIDER_INVITES_READ');
  // SEO-004 PR B: the "Arama motoru" tab reads with SEO_READ and saves with
  // SEO_CONTENT_WRITE. The address is changed in the SEO slug window — reached
  // from the form's "Adresi değiştir" — which needs SEO_READ to open and
  // CATEGORIES_WRITE (the API's slug route) to save.
  const canReadSeo = can('SEO_READ');
  const canChangeSlug = canReadSeo && canWriteCategory;

  const category = await fetchOrNotFound(() => apiFetch<Category>(`/admin/categories/${slug}`));
  const [questions, allCategories] = await Promise.all([
    canReadQuestions
      ? apiFetch<Question[]>(`/categories/${category.id}/questions`)
      : Promise.resolve<Question[] | null>(null),
    apiFetch<Category[]>('/admin/categories'),
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
  const invitable = category.kind === 'LEAF' && canReadInvites;
  const invites = invitable
    ? await apiFetch<ProviderInviteList>(`/categories/${category.id}/provider-invites`)
    : null;

  const sortedQuestions = [...(questions ?? [])].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label, 'tr-TR');
  });

  // The vitrin runs a status move would touch, counted from the real
  // placements, for the confirmation dialogs (ADMIN-DESTRUCTIVE-CONFIRMATION-001
  // Paket B). Only for a session that may move the status and read placements.
  const placementImpact: CategoryPlacementImpact =
    canChangeStatus && can('SHOWCASE_PLACEMENTS_READ') ? await readPlacementImpact(category.id) : null;

  const groups = allCategories.filter((candidate) => candidate.kind === 'GROUP' && candidate.id !== category.id);
  // A router may send the customer on to a service or to another router, never
  // to a group and never to itself. The picker offers exactly that.
  const routableTargets = allCategories.filter(
    (candidate) => candidate.kind !== 'GROUP' && candidate.id !== category.id,
  );

  const routerQuestion = sortedQuestions.find((question) => question.isRouter);
  const isRouter = category.kind === 'ROUTER';
  const isLeaf = category.kind === 'LEAF';
  // The same checks the release checklist on /categories runs, on the one
  // screen where somebody actually flips the status to ACTIVE.
  const blockers = releaseBlockers(category);
  const approvedProviders = category._count?.providers ?? 0;
  const activeInvites = category._count?.providerInvites ?? 0;

  const facts: SummaryItem[] = [
    { label: 'Tip', value: KIND_LABELS[category.kind], testId: 'category-fact-kind' },
    {
      label: 'Teklif kredisi',
      value: !isLeaf ? '—' : category.offerCreditCost === null ? 'Tanımsız' : category.offerCreditCost,
      note: !isLeaf ? 'bu tipte teklif verilmez' : category.offerCreditCost === null ? RELEASE_BLOCKER_LABELS.NO_PRICE : 'kredi / teklif',
      tone: isLeaf && category.offerCreditCost === null ? 'danger' : 'neutral',
      testId: 'category-fact-price',
    },
    ...(questions
      ? [
          {
            label: 'Soru',
            value: formatCount(questions.length),
            note: `${formatCount(questions.filter((question) => question.isActive).length)} aktif`,
            testId: 'category-fact-questions',
          } satisfies SummaryItem,
        ]
      : []),
    ...(isLeaf
      ? [
          {
            label: 'Onaylı hizmet veren',
            value: formatCount(approvedProviders),
            tone: approvedProviders === 0 ? 'danger' : 'neutral',
            testId: 'category-fact-providers',
          } satisfies SummaryItem,
          {
            label: 'Geçerli davet',
            value: formatCount(activeInvites),
            note: 'hazır sayılmaz',
            testId: 'category-fact-invites',
          } satisfies SummaryItem,
        ]
      : []),
    { label: 'Sıra', value: category.sortOrder },
  ];

  const path = `/categories/${category.slug}`;
  const tabs: TabItem[] = [
    { key: '', label: 'Kategori bilgileri', testId: 'category-tab-bilgiler' },
    ...(questions ? [{ key: 'sorular', label: 'Sorular', count: questions.length, testId: 'category-tab-sorular' }] : []),
    ...(invites
      ? [{ key: 'davetler', label: 'Hizmet veren davetleri', count: invites.invites.length, testId: 'category-tab-davetler' }]
      : []),
    ...(canReadSeo ? [{ key: 'arama-motoru', label: 'Arama motoru', testId: 'category-tab-arama-motoru' }] : []),
    { key: 'gecmis', label: 'Neler oldu', testId: 'category-tab-gecmis' },
  ];
  const activeTab = resolveTab<TabKey>(
    tab,
    tabs.map((item) => item.key as TabKey),
    '',
  );
  // ADMIN-ACTION-AUDIT-001: the category's change log, read on its own tab.
  const history =
    activeTab === 'gecmis' ? await getCategoryHistory(category.slug, parsePage(gecmisSayfa)) : null;
  const seoContent =
    activeTab === 'arama-motoru'
      ? await apiFetch<CategorySeoContent>(`/admin/seo/categories/${encodeURIComponent(category.id)}/content`)
      : null;
  const publiclyReachable = category.status === 'ACTIVE' && (category.kind === 'LEAF' || category.kind === 'ROUTER');

  return (
    <main className="catalog-page catalog-detail-page">
      <DetailHeader
        back={{ href: '/categories', label: 'Hizmet kategorileri' }}
        badges={
          <>
            <span className={statusBadgeClass(category.status)} data-testid="category-status">
              {STATUS_LABELS[category.status]}
            </span>
            <span className="badge badge-muted">{KIND_LABELS[category.kind]}</span>
            {/*
              The supply reading, beside the publishing one and never instead
              of it. A LIVE service says "Yayında" in both, which is the point:
              a released category has an answer to "is it published" and the
              supply question is then somebody else's — the release checklist
              still says whether anybody stands behind it.
            */}
            {category.supplyStatus ? (
              <span className={supplyStatusBadgeClass(category.supplyStatus)} data-testid="supply-status">
                {SUPPLY_STATUS_LABELS[category.supplyStatus]}
              </span>
            ) : null}
          </>
        }
        meta={
          <>
            <code className="cell-break">{category.slug}</code> ·{' '}
            {category.parent ? `${category.parent.name} altında` : 'üst seviye'}
          </>
        }
        title={category.name}
        subtitle={KIND_HINTS[category.kind]}
        facts={facts}
        factsLabel="Kategori özeti"
        testId="category-header"
      />

      {adres && adres === `/categories/${category.slug}` ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="category-slug-changed">
          Adres değiştirildi: <code>{adres}</code>.{' '}
          {yonlendirme === '1'
            ? 'Eski adres kalıcı (301) olarak yeni adrese yönlendiriliyor.'
            : 'Kategori herkese açık olmadığı için yönlendirme oluşturulmadı.'}
        </div>
      ) : null}

      {error === 'CONFIRMATION_REQUIRED' ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="category-error">
          {CONFIRMATION_PROOF_REFUSAL_MESSAGE}
        </div>
      ) : null}

      <Tabs label="Kategori sekmeleri" items={tabs} active={activeTab} path={path} testId="category-tabs" />

      {activeTab === '' ? (
        <div className="detail-tab-panel" data-testid="category-panel-bilgiler">
          <CategoryInfoSection
            category={category}
            groups={groups}
            canWrite={canWriteCategory}
            canChangeStatus={canChangeStatus}
            canUpload={canUpload}
            updateAction={updateCategoryAction}
            placementImpact={placementImpact}
            slugChangeHref={
              canChangeSlug
                ? `/seo/slugs?${new URLSearchParams({ kategori: category.id, geri: 'kategori' }).toString()}`
                : null
            }
            publiclyReachable={publiclyReachable}
          />

          {category.status === 'DRAFT' || canChangeStatus || isRouter ? (
            <div className="detail-card-grid">
              {category.status === 'DRAFT' ? (
                <ReleaseChecklistSection
                  category={category}
                  blockers={blockers}
                  questionCount={questions ? questions.length : null}
                />
              ) : null}

              {canChangeStatus ? (
                <CategoryStatusSection
                  category={category}
                  action={updateCategoryStatusAction}
                  placementImpact={placementImpact}
                />
              ) : null}

              {isRouter ? <RouterExplainerSection /> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'sorular' && questions ? (
        <div className="detail-tab-panel" data-testid="category-panel-sorular">
          {isRouter ? (
            <RouterTargetsSection
              categorySlug={category.slug}
              routerQuestion={routerQuestion}
              targets={routableTargets}
              canWriteQuestions={canWriteQuestions}
              replaceRulesAction={replaceRouterRulesAction}
            />
          ) : null}

          <QuestionSetSection
            category={category}
            questions={sortedQuestions}
            isRouter={isRouter}
            canWriteQuestions={canWriteQuestions}
            actions={{
              update: updateQuestionAction,
              replaceConditions: replaceQuestionConditionsAction,
              updateStatus: updateQuestionStatusAction,
              create: createQuestionAction,
            }}
          />
        </div>
      ) : null}

      {activeTab === 'davetler' && invites ? (
        <div className="detail-tab-panel" data-testid="category-panel-davetler">
          <ProviderInvitePanel
            activeCount={invites.activeCount}
            canIssue={category.status !== 'INACTIVE'}
            mayIssue={can('PROVIDER_INVITES_ISSUE')}
            mayRevoke={can('PROVIDER_INVITES_REVOKE')}
            categoryId={category.id}
            categoryName={category.name}
            categorySlug={category.slug}
            invites={invites.invites}
          />
        </div>
      ) : null}

      {activeTab === 'arama-motoru' && seoContent ? (
        <div className="detail-tab-panel" data-testid="category-panel-arama-motoru">
          <CategorySeoSection content={seoContent} canWrite={can('SEO_CONTENT_WRITE')} />
        </div>
      ) : null}

      {activeTab === 'gecmis' && history ? (
        <div className="detail-tab-panel" data-testid="category-panel-gecmis">
          <AuditTimeline
            page={history}
            meta={category.createdAt ? `Kategori ${formatDateTime(category.createdAt)} tarihinde oluşturuldu` : undefined}
            empty="Kayıt tutulmaya başladığından beri bu kategoride değişiklik yapılmadı."
            footnote={`${AUDIT_SINCE_NOTE} Soru değişiklikleri bu geçmişte yer almaz.`}
            testId="category-activity"
            pager={{ path, params: { tab: 'gecmis' }, pageParam: 'gecmisSayfa' }}
          />
          {invites ? (
            <ActivityLog
              entries={inviteActivity(invites.invites)}
              meta="Davet bağlantılarının kayıtlı zamanları"
              testId="category-invite-activity"
            />
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

/**
 * This category's vitrin runs a status move touches, from the placement list
 * the API keeps: ACTIVE ones (what closing suspends) and the ones suspended
 * with CATEGORY_CLOSED (what opening resumes). Null when the read fails — the
 * dialog then says it cannot count, it never prints a guess.
 */
async function readPlacementImpact(categoryId: string): Promise<CategoryPlacementImpact> {
  try {
    const { placements } = await apiFetch<{ placements: ShowcasePlacement[] }>(
      `/admin/showcase/placements?${new URLSearchParams({ categoryId }).toString()}`,
    );
    return {
      onAir: placements.filter((placement) => placement.status === 'ACTIVE').length,
      heldByClosure: placements.filter(
        (placement) => placement.status === 'SUSPENDED' && placement.suspendReason === 'CATEGORY_CLOSED',
      ).length,
    };
  } catch (error) {
    rethrowNextControlFlow(error);
    return null;
  }
}
