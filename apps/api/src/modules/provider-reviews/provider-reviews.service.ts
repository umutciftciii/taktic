import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  OfferStatus,
  Prisma,
  ProviderReviewModerationAction,
  ProviderReviewReportReason,
  ProviderReviewReportResolution,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import { assertNoContactDetails } from '../../common/contact-guard';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import {
  TransactionalMailService,
  readProviderReviewsEnabled,
} from '../notifications/transactional-mail.service';
import { isPubliclyVisibleProvider } from '../providers/providers.service';
import { CreateProviderReviewDto } from './dto/create-provider-review.dto';
import {
  toPublicSummary,
  toReviewSummary,
  type PublicReviewSummary,
  type ReviewSummary,
} from './provider-review-aggregate';
import { normalizeComment } from './provider-review-comment';
import { conflict, notFound } from './provider-review.errors';
import { isReviewWindowOpen, reviewWindowEndsAt } from './provider-review-window';
import {
  MATCH_INCONSISTENT_CODE,
  PUBLIC_REVIEW_LIST_MAX_LIMIT,
  REQUEST_NOT_COMPLETED_CODE,
  REVIEWS_DISABLED_CODE,
  REVIEW_ALREADY_EXISTS_CODE,
  REVIEW_LIST_MAX_LIMIT,
  REVIEW_WINDOW_CLOSED_CODE,
} from './provider-reviews.constants';

export type CustomerReviewEligibility =
  | 'ok'
  | 'disabled'
  | 'not-completed'
  | 'window-closed'
  | 'already-reviewed'
  | 'removed';

/** What the customer's review screen needs, and nothing about anyone else. */
export type CustomerReviewState = {
  eligibility: CustomerReviewEligibility;
  windowEndsAt: string | null;
  provider: { id: string; businessName: string } | null;
  review: {
    id: string;
    rating: number;
    comment: string | null;
    createdAt: string;
    commentRemoved: boolean;
    removed: boolean;
    removalReason: ProviderReviewReportReason | null;
  } | null;
};

/**
 * One row of the provider's own list: the job, the verdict and the provider's
 * own report — never the customer.
 */
export type ProviderReviewItem = {
  id: string;
  rating: number;
  comment: string | null;
  commentRemoved: boolean;
  createdAt: string;
  request: { id: string; requestNumber: string | null; categoryName: string };
  myReport: {
    reason: ProviderReviewReportReason;
    createdAt: string;
    resolution: ProviderReviewReportResolution | null;
  } | null;
};

/** One row of the public list: nothing that could name the reviewer. */
export type PublicReviewItem = {
  id: string;
  rating: number;
  comment: string;
  /** YYYY-MM — the month, never the day. */
  month: string;
  categoryName: string;
};

export type ProviderReviewList = {
  summary: ReviewSummary;
  items: ProviderReviewItem[];
  nextCursor: string | null;
};

export type PublicReviewList = {
  summary: PublicReviewSummary;
  items: PublicReviewItem[];
  nextCursor: string | null;
};

/** Newest first; the id breaks ties so a cursor never skips or repeats a row. */
const REVIEW_LIST_ORDER = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.ProviderReviewOrderByWithRelationInput[];

const REMOVAL_ACTIONS: ProviderReviewModerationAction[] = [
  ProviderReviewModerationAction.REMOVE_COMMENT,
  ProviderReviewModerationAction.REMOVE_REVIEW,
];

/**
 * One shape for both the create predicate and the state projection, so the
 * two can never disagree about which offer the review belongs to.
 */
const customerReviewSelect = {
  id: true,
  status: true,
  customerId: true,
  completedAt: true,
  matchedOffer: {
    select: {
      id: true,
      providerId: true,
      status: true,
      provider: { select: { id: true, businessName: true } },
    },
  },
  // A list relation on the schema, but `@@unique([requestId, providerId])`
  // plus a single matched offer means at most one row per request in practice.
  reviews: {
    take: 1,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      rating: true,
      comment: true,
      createdAt: true,
      commentRemovedAt: true,
      removedAt: true,
      moderation: {
        where: { action: { in: REMOVAL_ACTIONS } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { reason: true },
      },
    },
  },
} satisfies Prisma.ServiceRequestSelect;

type CustomerReviewRequest = Prisma.ServiceRequestGetPayload<{ select: typeof customerReviewSelect }>;

@Injectable()
export class ProviderReviewsService {
  private readonly logger = new Logger(ProviderReviewsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * The owning customer rates the provider whose offer was accepted, once,
   * within the window after completion. The provider is read from the matched
   * offer inside this method — never from the body — and the unique index on
   * `offerId` is what turns a double-click into a 409 rather than a second row.
   */
  async createForCustomer(
    requestId: string,
    user: AuthUser,
    dto: CreateProviderReviewDto,
  ): Promise<CustomerReviewState> {
    if (!(await readProviderReviewsEnabled(this.prisma))) {
      throw notFound(REVIEWS_DISABLED_CODE, 'Değerlendirme özelliği kapalı.');
    }

    const request = await this.loadForCustomer(requestId, user);

    if (request.status !== ServiceRequestStatus.COMPLETED) {
      throw conflict(REQUEST_NOT_COMPLETED_CODE, 'Yalnızca tamamlanmış bir iş değerlendirilebilir.');
    }

    const offer = request.matchedOffer;
    if (!offer || offer.status !== OfferStatus.ACCEPTED) {
      throw conflict(MATCH_INCONSISTENT_CODE, 'Bu talebin kabul edilmiş bir teklifi bulunamadı.');
    }

    if (!request.completedAt || !isReviewWindowOpen(request.completedAt)) {
      throw conflict(REVIEW_WINDOW_CLOSED_CODE, 'Değerlendirme süresi doldu.');
    }

    const comment = normalizeComment(dto.comment);
    assertNoContactDetails('comment', comment);

    let review: { id: string };
    try {
      review = await this.prisma.providerReview.create({
        data: {
          requestId: request.id,
          offerId: offer.id,
          providerId: offer.providerId,
          customerUserId: user.id,
          rating: dto.rating,
          comment,
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict(REVIEW_ALREADY_EXISTS_CODE, 'Bu iş için değerlendirmeniz zaten var.');
      }
      throw error;
    }

    await this.notifySafely(() => this.mail.sendReviewReceived(review.id), request.id);

    return this.getForCustomer(requestId, user);
  }

  async getForCustomer(requestId: string, user: AuthUser): Promise<CustomerReviewState> {
    const enabled = await readProviderReviewsEnabled(this.prisma);
    const request = await this.loadForCustomer(requestId, user);
    return toCustomerReviewState(request, enabled);
  }

  /**
   * Live rows only (`removedAt IS NULL`), one `groupBy` for every id, and an
   * empty summary for an id with no rows so a caller can index the map
   * without a fallback. Not gated by the switch: this feeds the provider's
   * own panel, which keeps showing its data while the feature is off.
   */
  async summariesForProviders(providerIds: readonly string[]): Promise<Map<string, ReviewSummary>> {
    const result = new Map<string, ReviewSummary>();
    if (providerIds.length === 0) {
      return result;
    }

    const rows = await this.prisma.providerReview.groupBy({
      by: ['providerId', 'rating'],
      where: { providerId: { in: [...providerIds] }, removedAt: null },
      _count: { _all: true },
    });

    for (const id of providerIds) {
      result.set(id, toReviewSummary([]));
    }

    const byProvider = new Map<string, { rating: number; count: number }[]>();
    for (const row of rows) {
      byProvider.set(row.providerId, [
        ...(byProvider.get(row.providerId) ?? []),
        { rating: row.rating, count: row._count._all },
      ]);
    }
    for (const [id, entries] of byProvider) {
      result.set(id, toReviewSummary(entries));
    }

    return result;
  }

  /**
   * The public projection of the same numbers: `toPublicSummary` is the one
   * place the minimum-count threshold lives, so offer cards, the vitrin and
   * the public list can never disagree about who has a rating. Fails closed:
   * with the switch off every id maps to null after a single settings read.
   */
  async publicSummariesForProviders(
    providerIds: readonly string[],
  ): Promise<Map<string, PublicReviewSummary>> {
    const result = new Map<string, PublicReviewSummary>();
    if (providerIds.length === 0) {
      return result;
    }

    if (!(await readProviderReviewsEnabled(this.prisma))) {
      for (const id of providerIds) {
        result.set(id, null);
      }
      return result;
    }

    for (const [id, summary] of await this.summariesForProviders(providerIds)) {
      result.set(id, toPublicSummary(summary));
    }
    return result;
  }

  async summaryForProvider(providerId: string): Promise<ReviewSummary> {
    return (await this.summariesForProviders([providerId])).get(providerId) ?? toReviewSummary([]);
  }

  /**
   * The provider's own list. Removed reviews are gone; a removed comment
   * leaves the star and a `commentRemoved` flag; `myReport` is the latest
   * report *this* provider filed. Access is the guard's job — the owner or a
   * SUPER_ADMIN — so nothing here checks the caller.
   */
  async listForProvider(
    providerId: string,
    cursor: string | null,
    limit: number,
  ): Promise<ProviderReviewList> {
    const take = clampLimit(limit, REVIEW_LIST_MAX_LIMIT);
    const rows = await this.prisma.providerReview.findMany({
      where: { providerId, removedAt: null },
      orderBy: REVIEW_LIST_ORDER,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        rating: true,
        comment: true,
        commentRemovedAt: true,
        createdAt: true,
        request: {
          select: { id: true, requestNumber: true, category: { select: { name: true } } },
        },
        reports: {
          where: { reporterProviderId: providerId },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { reason: true, createdAt: true, resolution: true },
        },
      },
    });

    const page = rows.slice(0, take);
    return {
      summary: await this.summaryForProvider(providerId),
      items: page.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.commentRemovedAt ? null : row.comment,
        commentRemoved: row.commentRemovedAt !== null,
        createdAt: row.createdAt.toISOString(),
        request: {
          id: row.request.id,
          requestNumber: row.request.requestNumber,
          categoryName: row.request.category.name,
        },
        myReport: row.reports[0]
          ? {
              reason: row.reports[0].reason,
              createdAt: row.reports[0].createdAt.toISOString(),
              resolution: row.reports[0].resolution,
            }
          : null,
      })),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * What a visitor sees. 404 — the same "Provider not found" as the public
   * profile — when the provider is not listable or the switch is off, so an
   * unlistable provider's reviews are indistinguishable from a non-existent
   * provider's. Below the public threshold the list is empty as well as the
   * summary null: the section does not exist yet, and two lone comments with
   * a month and a category would be easier to pin on a person than a
   * rating.
   */
  async listPublic(
    providerId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PublicReviewList> {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { status: true },
    });
    if (
      !provider ||
      !isPubliclyVisibleProvider(provider.status) ||
      !(await readProviderReviewsEnabled(this.prisma))
    ) {
      throw new NotFoundException('Provider not found');
    }

    const summary = toPublicSummary(await this.summaryForProvider(providerId));
    if (summary === null) {
      return { summary, items: [], nextCursor: null };
    }

    const take = clampLimit(limit, PUBLIC_REVIEW_LIST_MAX_LIMIT);
    const rows = await this.prisma.providerReview.findMany({
      where: { providerId, removedAt: null, commentRemovedAt: null, comment: { not: null } },
      orderBy: REVIEW_LIST_ORDER,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        request: { select: { category: { select: { name: true } } } },
      },
    });

    const page = rows.slice(0, take);
    return {
      summary,
      items: page.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment ?? '',
        month: row.createdAt.toISOString().slice(0, 7),
        categoryName: row.request.category.name,
      })),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * 404 when the request does not exist; a SUPER_ADMIN may look; anyone else
   * who is not the owning customer is refused — the same rule as the lifecycle
   * actions in `ServiceRequestsService`.
   */
  private async loadForCustomer(requestId: string, user: AuthUser): Promise<CustomerReviewRequest> {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: customerReviewSelect,
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      return request;
    }

    if (user.role !== UserRole.CUSTOMER || !request.customerId || request.customerId !== user.id) {
      throw new ForbiddenException('Service request access denied');
    }

    return request;
  }

  /**
   * Past the commit point: the review row exists, so a failure here must not
   * turn a successful submission into an error response. The mail service
   * records transport failures in NotificationLog itself; this catches a bug in
   * the composing code.
   */
  private async notifySafely(run: () => Promise<unknown>, requestId: string) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Failed to send a review notification for request ${requestId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/**
 * The verdict is worked out in the create predicate's order — switch, status,
 * match, then the window — with one exception: an existing review is reported
 * before the window is checked, because a review written in time stays the
 * customer's review after the window closes. The other fields are plain facts
 * and are filled in whatever the verdict.
 */
function toCustomerReviewState(request: CustomerReviewRequest, enabled: boolean): CustomerReviewState {
  const offer = request.matchedOffer;
  const review = request.reviews[0] ?? null;

  const eligibility = ((): CustomerReviewEligibility => {
    if (!enabled) return 'disabled';
    if (request.status !== ServiceRequestStatus.COMPLETED) return 'not-completed';
    if (!offer || offer.status !== OfferStatus.ACCEPTED) return 'not-completed';
    if (review) return review.removedAt ? 'removed' : 'already-reviewed';
    if (!request.completedAt || !isReviewWindowOpen(request.completedAt)) return 'window-closed';
    return 'ok';
  })();

  return {
    eligibility,
    windowEndsAt: request.completedAt ? reviewWindowEndsAt(request.completedAt).toISOString() : null,
    provider: offer ? { id: offer.provider.id, businessName: offer.provider.businessName } : null,
    review: review
      ? {
          id: review.id,
          rating: review.rating,
          comment: review.commentRemovedAt ? null : review.comment,
          createdAt: review.createdAt.toISOString(),
          commentRemoved: review.commentRemovedAt !== null,
          removed: review.removedAt !== null,
          // Only while something is actually removed: after a RESTORE the
          // old reason is history, not state.
          removalReason:
            review.removedAt !== null || review.commentRemovedAt !== null
              ? (review.moderation[0]?.reason ?? null)
              : null,
        }
      : null,
  };
}

function clampLimit(limit: number, max: number): number {
  return Number.isInteger(limit) ? Math.min(Math.max(1, limit), max) : max;
}
