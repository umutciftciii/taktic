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
  ProviderInviteList,
  Question,
  requireAdmin,
} from '../../../lib/api';
import { formatCount } from '../../../lib/pagination';
import { DetailHeader } from '../../../components/detail-header';
import type { SummaryItem } from '../../../components/summary-strip';
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
  QuestionHintsSection,
  QuestionSetSection,
  ReleaseChecklistSection,
  RouterExplainerSection,
  RouterTargetsSection,
} from './category-sections';

/**
 * One category (#40). The design has no screen for it (`soon`); it is built on
 * the detail template (ADMIN-DESIGN-001 Faz 3F): a way back to the list, the
 * summary card — status, type and supply badges, the slug and where it hangs,
 * the name, and a strip with the figures a release is decided on — then the
 * editors in the main column and the desk beside them.
 *
 * Nothing on this screen changed what it does. The inventory it was converted
 * against (plan belgesi, "Faz 3F envanter") lists every section and control
 * with the condition it is drawn under; each one is drawn under that same
 * condition here:
 *
 * - CATEGORIES_WRITE: the category form, otherwise its values read-only. The
 *   status select in it moves only with CATEGORIES_STATUS (`statusLocked`).
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
};

export default async function CategoryDetailPage({ params }: CategoryDetailPageProps) {
  const { can } = await requireAdmin('CATALOG_READ');
  const { slug } = await params;
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

      <div className="admin-module-layout catalog-detail-layout">
        <div className="admin-main-column">
          <CategoryInfoSection
            category={category}
            groups={groups}
            canWrite={canWriteCategory}
            canChangeStatus={canChangeStatus}
            canUpload={canUpload}
            updateAction={updateCategoryAction}
          />

          {isRouter && questions ? (
            <RouterTargetsSection
              categorySlug={category.slug}
              routerQuestion={routerQuestion}
              targets={routableTargets}
              canWriteQuestions={canWriteQuestions}
              replaceRulesAction={replaceRouterRulesAction}
            />
          ) : null}

          {questions ? (
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
          ) : null}
        </div>

        <aside className="admin-side-column" aria-label="Kategori işlemleri">
          {canChangeStatus ? <CategoryStatusSection category={category} action={updateCategoryStatusAction} /> : null}

          {category.status === 'DRAFT' ? (
            <ReleaseChecklistSection
              category={category}
              blockers={blockers}
              questionCount={questions ? questions.length : null}
            />
          ) : null}

          {invites ? (
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
          ) : null}

          {isRouter ? <RouterExplainerSection /> : null}

          <QuestionHintsSection />
        </aside>
      </div>
    </main>
  );
}
