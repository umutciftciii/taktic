import { Prisma } from '@prisma/client';
import { describeArea } from '../../common/provider-service-area-scope';

/**
 * What a card, a version and an area look like on the way out — one shape, read
 * by the provider's panel and the operator's queue alike.
 *
 * The two audiences see the same card content on purpose: the rejection note is
 * written *for* the provider, and the review row records a decision the provider
 * is entitled to see. What differs is which cards they can address at all —
 * settled by the guards — and one field: who on the staff decided, which is the
 * operator's audit and never the provider's (see {@link ShowcaseProjectionOptions}).
 */

export const showcaseAreaSelect = {
  id: true,
  scope: true,
  city: true,
  district: true,
  neighborhood: true,
  areaKey: true,
} satisfies Prisma.ShowcaseCardVersionAreaSelect;

export const showcaseVersionInclude = {
  areas: { orderBy: [{ areaKey: 'asc' }], select: showcaseAreaSelect },
  review: {
    select: {
      id: true,
      decision: true,
      note: true,
      createdAt: true,
      reviewedBy: { select: { id: true, name: true, email: true } },
    },
  },
} satisfies Prisma.ShowcaseCardVersionInclude;

export const showcaseCardInclude = {
  category: { select: { id: true, name: true, slug: true, kind: true, status: true } },
  liveVersion: { include: showcaseVersionInclude },
  draftVersion: { include: showcaseVersionInclude },
  /*
   * The most recent refused version. A rejection clears the draft pointer, so
   * a card whose first version was refused points at nothing — and its owner
   * would otherwise be shown a blank card with no note and no text to fix.
   * The newest refusal is enough: it is the verdict still to be acted on.
   */
  versions: {
    where: { reviewStatus: 'REJECTED' },
    orderBy: [{ versionNumber: 'desc' }],
    take: 1,
    include: showcaseVersionInclude,
  },
} satisfies Prisma.ShowcaseCardInclude;

type AreaRow = Prisma.ShowcaseCardVersionAreaGetPayload<{ select: typeof showcaseAreaSelect }>;
type VersionRow = Prisma.ShowcaseCardVersionGetPayload<{ include: typeof showcaseVersionInclude }>;
type CardRow = Prisma.ShowcaseCardGetPayload<{ include: typeof showcaseCardInclude }>;

/**
 * An area with the sentence the rest of the product already prints for that
 * scope — "İstanbul geneli", "Moda, Kadıköy, İstanbul".
 *
 * Composed here rather than in each client, so the provider's chip, the
 * operator's review screen and any future surface read one wording. `areaKey`
 * travels too: it is not a secret, it is the identity the narrowing rule and the
 * audit rows use, and an operator comparing two versions needs to be able to see
 * which areas are literally the same one.
 */
export function toShowcaseArea(area: AreaRow) {
  return {
    id: area.id,
    scope: area.scope,
    city: area.city,
    district: area.district,
    neighborhood: area.neighborhood,
    areaKey: area.areaKey,
    label: describeArea({
      city: area.city,
      district: area.district,
      neighborhood: area.neighborhood,
    }),
  };
}

/**
 * Whose eyes a projection is for (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-002).
 *
 * The review row records which operator decided. That is the platform's
 * internal audit, not part of the verdict: the provider is told the decision,
 * its note and when — never who on the staff made it, neither name nor
 * address, so `reviewedBy` is absent from the provider's projection (its
 * screen speaks for "TakTick inceleme ekibi" instead). An operator sees the
 * reviewer by id and name; the e-mail is the staff directory's
 * (ADMIN_USERS_READ, `mayEmbedStaffEmail`). The default is the provider's.
 */
export type ShowcaseProjectionOptions =
  | { audience: 'PROVIDER' }
  | { audience: 'OPERATOR'; reviewerEmail: boolean };

const PROVIDER_VIEW: ShowcaseProjectionOptions = { audience: 'PROVIDER' };

function toReview(review: NonNullable<VersionRow['review']>, options: ShowcaseProjectionOptions) {
  const verdict = {
    id: review.id,
    decision: review.decision,
    note: review.note,
    createdAt: review.createdAt,
  };
  if (options.audience === 'PROVIDER') {
    return verdict;
  }
  const reviewer = review.reviewedBy;
  return {
    ...verdict,
    reviewedBy: reviewer
      ? { id: reviewer.id, name: reviewer.name, ...(options.reviewerEmail ? { email: reviewer.email } : {}) }
      : null,
  };
}

export function toShowcaseVersion(version: VersionRow, options: ShowcaseProjectionOptions = PROVIDER_VIEW) {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    kind: version.kindSnapshot,
    title: version.title,
    summary: version.summary,
    scopeIncluded: version.scopeIncluded,
    scopeExcluded: version.scopeExcluded,
    listedServicePriceAmount: version.listedServicePriceAmount,
    listedServiceCurrency: version.listedServiceCurrency,
    imageUrl: version.imageUrl,
    responseSlaUrgentHours: version.responseSlaUrgentHours,
    responseSlaNormalHours: version.responseSlaNormalHours,
    priceTermsVersion: version.priceTermsVersion,
    priceTermsAcceptedAt: version.priceTermsAcceptedAt,
    reviewStatus: version.reviewStatus,
    submittedAt: version.submittedAt,
    publishedAt: version.publishedAt,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    areas: version.areas.map(toShowcaseArea),
    review: version.review ? toReview(version.review, options) : null,
  };
}

export function toShowcaseCard(card: CardRow, options: ShowcaseProjectionOptions = PROVIDER_VIEW) {
  return {
    id: card.id,
    kind: card.kind,
    status: card.status,
    category: card.category,
    liveVersion: card.liveVersion ? toShowcaseVersion(card.liveVersion, options) : null,
    draftVersion: card.draftVersion ? toShowcaseVersion(card.draftVersion, options) : null,
    rejectedVersion: rejectedVersion(card, options),
    suspendedAt: card.suspendedAt,
    suspendReason: card.suspendReason,
    archivedAt: card.archivedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

/**
 * The refusal the provider still has to act on, with its note.
 *
 * Two cases, one rule — the newest refused version, while nothing newer has
 * superseded it:
 *
 * - a card with no draft and no live version: its first version was refused;
 * - a card whose live version is *older* than the refusal, and with no draft:
 *   a revision of approved text was refused (API-HARDENING-001). The card
 *   stays APPROVED and keeps serving the live text, so this field is the only
 *   place the refusal and its note reach the provider's panel.
 *
 * A new draft supersedes the refusal (the provider is acting on it), and so
 * does a later approval (the live version is then newer). The rows may arrive
 * as the one-row filtered include above or, from the operator's card screen,
 * as the card's whole history newest first — so the status is checked here
 * rather than assumed from the include.
 */
function rejectedVersion(card: CardRow, options: ShowcaseProjectionOptions) {
  if (card.draftVersion) {
    return null;
  }
  const refused = card.versions.find(
    (version) => version.reviewStatus === 'REJECTED',
  );
  if (!refused) {
    return null;
  }
  if (card.liveVersion && card.liveVersion.versionNumber > refused.versionNumber) {
    return null;
  }
  return toShowcaseVersion(refused, options);
}

export type ShowcaseCardProjection = ReturnType<typeof toShowcaseCard>;
export type ShowcaseVersionProjection = ReturnType<typeof toShowcaseVersion>;
