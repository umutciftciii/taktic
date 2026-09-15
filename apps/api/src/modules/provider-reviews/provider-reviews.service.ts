import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  OfferStatus,
  Prisma,
  ProviderReviewModerationAction,
  ProviderReviewReportReason,
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
import { CreateProviderReviewDto } from './dto/create-provider-review.dto';
import { normalizeComment } from './provider-review-comment';
import { conflict, notFound } from './provider-review.errors';
import { isReviewWindowOpen, reviewWindowEndsAt } from './provider-review-window';
import {
  MATCH_INCONSISTENT_CODE,
  REQUEST_NOT_COMPLETED_CODE,
  REVIEWS_DISABLED_CODE,
  REVIEW_ALREADY_EXISTS_CODE,
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
