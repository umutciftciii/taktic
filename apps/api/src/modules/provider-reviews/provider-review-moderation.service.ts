import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ProviderReviewModerationAction,
  ProviderReviewReportReason,
  ProviderReviewReportResolution,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { CreateProviderReviewReportDto } from './dto/create-provider-review-report.dto';
import { DismissProviderReviewReportDto } from './dto/dismiss-provider-review-report.dto';
import { ModerateProviderReviewDto } from './dto/moderate-provider-review.dto';
import { conflict, tooMany } from './provider-review.errors';
import {
  NO_OPEN_REVIEW_REPORT_CODE,
  REVIEW_MODERATION_NOOP_CODE,
  REVIEW_NOT_REPORTABLE_CODE,
  REVIEW_REPORT_ALREADY_EXISTS_CODE,
  REVIEW_REPORT_MAX_PER_PROVIDER_PER_DAY,
  REVIEW_REPORT_RATE_LIMITED_CODE,
} from './provider-reviews.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How much of a comment the queue shows on a row. */
const QUEUE_EXCERPT_LENGTH = 160;

const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 100;

/** The partial unique index on open reports, named in the migration's raw SQL. */
const ONE_OPEN_REPORT_INDEX = 'ProviderReviewReport_one_open_per_review';

export type ReviewReportQueueState = 'open' | 'resolved';

/** One report on the operator's queue, with enough of its review to triage it. */
export type ReviewReportQueueItem = {
  report: {
    id: string;
    reason: ProviderReviewReportReason;
    note: string | null;
    createdAt: string;
    resolvedAt: string | null;
    resolution: ProviderReviewReportResolution | null;
  };
  review: {
    id: string;
    rating: number;
    commentExcerpt: string;
    commentRemoved: boolean;
    removed: boolean;
    createdAt: string;
  };
  provider: { id: string; businessName: string };
  request: { id: string; requestNumber: string | null; categoryName: string };
  /** The latest operator action on the review, whatever this report's own decision was. */
  lastDecision: {
    action: ProviderReviewModerationAction;
    reason: ProviderReviewReportReason | null;
    createdAt: string;
  } | null;
};

/**
 * Everything an operator may see about one review: the text even after its
 * removal, the customer's name, every report with its note, and the log.
 * Admin-only by construction — nothing here is reused by another projection.
 */
export type AdminReviewDetail = {
  id: string;
  rating: number;
  comment: string | null;
  commentRemoved: boolean;
  commentRemovedAt: string | null;
  removed: boolean;
  removedAt: string | null;
  createdAt: string;
  provider: { id: string; businessName: string };
  request: {
    id: string;
    requestNumber: string | null;
    categoryName: string;
    city: string;
    district: string;
    customerName: string;
  };
  reports: {
    id: string;
    reason: ProviderReviewReportReason;
    note: string | null;
    createdAt: string;
    resolvedAt: string | null;
    resolution: ProviderReviewReportResolution | null;
    resolutionNote: string | null;
    reporter: { id: string; businessName: string };
    resolvedBy: { id: string; name: string | null } | null;
  }[];
  moderation: {
    id: string;
    action: ProviderReviewModerationAction;
    reason: ProviderReviewReportReason | null;
    note: string | null;
    createdAt: string;
    performedBy: { id: string; name: string | null };
  }[];
};

const adminReviewSelect = {
  id: true,
  rating: true,
  comment: true,
  commentRemovedAt: true,
  removedAt: true,
  createdAt: true,
  provider: { select: { id: true, businessName: true } },
  request: {
    select: {
      id: true,
      requestNumber: true,
      city: true,
      district: true,
      customerName: true,
      category: { select: { name: true } },
    },
  },
  reports: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      reason: true,
      note: true,
      createdAt: true,
      resolvedAt: true,
      resolution: true,
      resolutionNote: true,
      reporter: { select: { id: true, businessName: true } },
      resolvedBy: { select: { id: true, name: true } },
    },
  },
  moderation: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      action: true,
      reason: true,
      note: true,
      createdAt: true,
      performedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ProviderReviewSelect;

/**
 * Reports by the reviewed business and the operator's decisions about a
 * review. A report changes nothing a visitor sees; only `moderate` does, and
 * it does so through a conditional update whose predicate is the review's
 * current state, so two operators acting at once get one success and one 409.
 */
@Injectable()
export class ProviderReviewModerationService {
  private readonly logger = new Logger(ProviderReviewModerationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  // ─────────────────────────────── provider ───────────────────────────────

  /**
   * The reviewed provider flags a comment. The review is looked up under the
   * caller's own provider id, so somebody else's review is a 404 — the same
   * answer as no review at all. Only a live comment is reportable, once while
   * a report is open; the partial unique index is the second line behind the
   * `count`, for two clicks that land in the same instant.
   */
  async reportForProvider(providerId: string, reviewId: string, dto: CreateProviderReviewReportDto) {
    const review = await this.prisma.providerReview.findFirst({
      where: { id: reviewId, providerId },
      select: { id: true, comment: true, commentRemovedAt: true, removedAt: true },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    if (!review.comment || review.commentRemovedAt || review.removedAt) {
      throw conflict(REVIEW_NOT_REPORTABLE_CODE, 'Bu değerlendirmede bildirilecek bir yorum yok.');
    }

    const open = await this.prisma.providerReviewReport.count({
      where: { reviewId, resolvedAt: null },
    });
    if (open > 0) {
      throw conflict(REVIEW_REPORT_ALREADY_EXISTS_CODE, 'Bu yorumu zaten bildirdiniz; inceleme bekliyor.');
    }

    const since = new Date(Date.now() - DAY_MS);
    const today = await this.prisma.providerReviewReport.count({
      where: { reporterProviderId: providerId, createdAt: { gte: since } },
    });
    if (today >= REVIEW_REPORT_MAX_PER_PROVIDER_PER_DAY) {
      throw tooMany(REVIEW_REPORT_RATE_LIMITED_CODE, 'Günlük bildirim sınırına ulaştınız.');
    }

    let report: { id: string; reason: ProviderReviewReportReason; createdAt: Date };
    try {
      report = await this.prisma.providerReviewReport.create({
        data: {
          reviewId,
          reporterProviderId: providerId,
          reason: dto.reason,
          note: dto.note?.trim() || null,
        },
        select: { id: true, reason: true, createdAt: true },
      });
    } catch (error) {
      if (isOpenReportConflict(error)) {
        throw conflict(REVIEW_REPORT_ALREADY_EXISTS_CODE, 'Bu yorumu zaten bildirdiniz; inceleme bekliyor.');
      }
      throw error;
    }

    // After the row exists: the support inbox hears about a report that is
    // really there, and a failed send cannot take the report with it.
    await this.notifySafely(() => this.mail.sendReviewReportNewForSupport(report.id), reviewId);
    return report;
  }

  // ──────────────────────────────── admin ─────────────────────────────────

  /**
   * The queue, one row per report, oldest first in the requested state. A
   * report's own decision is on the row; `lastDecision` is the review's latest
   * moderation action, so a dismissed report on a review that was removed
   * later — or a removal that was since restored — reads as what it is.
   */
  async listQueue(
    state: ReviewReportQueueState,
    cursor: string | null,
    limit = QUEUE_DEFAULT_LIMIT,
  ): Promise<{ items: ReviewReportQueueItem[]; nextCursor: string | null }> {
    const pageSize = Math.min(Math.max(1, Math.trunc(limit)), QUEUE_MAX_LIMIT);
    const inState: Prisma.ProviderReviewReportWhereInput =
      state === 'open' ? { resolvedAt: null } : { resolvedAt: { not: null } };

    const rows = await this.prisma.providerReviewReport.findMany({
      where: inState,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        reason: true,
        note: true,
        createdAt: true,
        resolvedAt: true,
        resolution: true,
        review: {
          select: {
            id: true,
            rating: true,
            comment: true,
            commentRemovedAt: true,
            removedAt: true,
            createdAt: true,
            provider: { select: { id: true, businessName: true } },
            request: {
              select: { id: true, requestNumber: true, category: { select: { name: true } } },
            },
            moderation: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: { action: true, reason: true, createdAt: true },
            },
          },
        },
      },
    });

    const page = rows.slice(0, pageSize);
    return {
      items: page.map((row) => ({
        report: {
          id: row.id,
          reason: row.reason,
          note: row.note,
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
          resolution: row.resolution,
        },
        review: {
          id: row.review.id,
          rating: row.review.rating,
          commentExcerpt: (row.review.comment ?? '').slice(0, QUEUE_EXCERPT_LENGTH),
          commentRemoved: row.review.commentRemovedAt !== null,
          removed: row.review.removedAt !== null,
          createdAt: row.review.createdAt.toISOString(),
        },
        provider: row.review.provider,
        request: {
          id: row.review.request.id,
          requestNumber: row.review.request.requestNumber,
          categoryName: row.review.request.category.name,
        },
        lastDecision: row.review.moderation[0]
          ? {
              action: row.review.moderation[0].action,
              reason: row.review.moderation[0].reason,
              createdAt: row.review.moderation[0].createdAt.toISOString(),
            }
          : null,
      })),
      nextCursor: rows.length > pageSize ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getForAdmin(reviewId: string): Promise<AdminReviewDetail> {
    const review = await this.prisma.providerReview.findUnique({
      where: { id: reviewId },
      select: adminReviewSelect,
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    return {
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      commentRemoved: review.commentRemovedAt !== null,
      commentRemovedAt: review.commentRemovedAt?.toISOString() ?? null,
      removed: review.removedAt !== null,
      removedAt: review.removedAt?.toISOString() ?? null,
      createdAt: review.createdAt.toISOString(),
      provider: review.provider,
      request: {
        id: review.request.id,
        requestNumber: review.request.requestNumber,
        categoryName: review.request.category.name,
        city: review.request.city,
        district: review.request.district,
        customerName: review.request.customerName,
      },
      reports: review.reports.map((report) => ({
        id: report.id,
        reason: report.reason,
        note: report.note,
        createdAt: report.createdAt.toISOString(),
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        resolution: report.resolution,
        resolutionNote: report.resolutionNote,
        reporter: report.reporter,
        resolvedBy: report.resolvedBy,
      })),
      moderation: review.moderation.map((row) => ({
        id: row.id,
        action: row.action,
        reason: row.reason,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        performedBy: row.performedBy,
      })),
    };
  }

  /**
   * The one operator action on a review, and everything it implies, in one
   * serializable transaction: the stamp on the review, the append-only log
   * row, and — for a removal — every open report closed with the matching
   * resolution.
   *
   * The stamp is a conditional `updateMany` whose `where` repeats the state
   * the action requires (a live comment to remove, a live review to remove,
   * something removed to restore). No lock is taken and none is needed: the
   * predicate is evaluated against the row as the transaction sees it, so of
   * two operators acting at once exactly one updates a row and the other's
   * count is zero — a 409 `REVIEW_MODERATION_NOOP`, the same answer a repeated
   * click gets. Nothing else in the transaction runs on a zero count.
   *
   * The customer is mailed after the commit, only for a removal, and is told
   * the reason's fixed label and nothing else: not the reporter, not the note.
   */
  async moderate(
    reviewId: string,
    dto: ModerateProviderReviewDto,
    adminUserId: string,
  ): Promise<AdminReviewDetail> {
    const now = new Date();
    const note = dto.note?.trim() || null;
    const isRestore = dto.action === ProviderReviewModerationAction.RESTORE;
    // The DTO makes the reason mandatory for a removal; the check is what
    // turns that promise into a type, and the CHECK constraint what keeps a
    // RESTORE row's reason NULL.
    const reason = isRestore ? null : dto.reason;
    if (!isRestore && !reason) {
      throw new BadRequestException('Kaldırmak için gerekçe seçilmelidir.');
    }

    const outcome = await runSerializable(
      this.prisma,
      async (tx) => {
        const review = await tx.providerReview.findUnique({
          where: { id: reviewId },
          select: { id: true },
        });
        if (!review) {
          throw new NotFoundException('Review not found');
        }

        const updated = await tx.providerReview.updateMany({
          where: { id: reviewId, ...moderationPredicate(dto.action) },
          data: moderationData(dto.action, now),
        });
        if (updated.count !== 1) {
          throw conflict(
            REVIEW_MODERATION_NOOP_CODE,
            'Bu işlem değerlendirmenin mevcut durumunda uygulanamaz.',
          );
        }

        await tx.providerReviewModeration.create({
          data: { reviewId, action: dto.action, reason, note, performedById: adminUserId, createdAt: now },
        });

        if (isRestore) {
          return { removed: false as const };
        }

        await tx.providerReviewReport.updateMany({
          where: { reviewId, resolvedAt: null },
          data: {
            resolvedAt: now,
            resolvedByUserId: adminUserId,
            resolution:
              dto.action === ProviderReviewModerationAction.REMOVE_COMMENT
                ? ProviderReviewReportResolution.COMMENT_REMOVED
                : ProviderReviewReportResolution.REVIEW_REMOVED,
            resolutionNote: note,
          },
        });
        return { removed: true as const };
      },
      { label: 'providerReviews.moderate' },
    );

    if (outcome.removed) {
      await this.notifySafely(() => this.mail.sendReviewRemoved(reviewId, now), reviewId);
    }
    return this.getForAdmin(reviewId);
  }

  /**
   * Closes the open report without touching the review. One atomic
   * `updateMany`: a zero count — nothing open, or a colleague got there first
   * — is a 409, and there is no moderation row because nothing was moderated.
   */
  async dismissReport(
    reviewId: string,
    dto: DismissProviderReviewReportDto,
    adminUserId: string,
  ): Promise<AdminReviewDetail> {
    const review = await this.prisma.providerReview.findUnique({
      where: { id: reviewId },
      select: { id: true },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    const closed = await this.prisma.providerReviewReport.updateMany({
      where: { reviewId, resolvedAt: null },
      data: {
        resolvedAt: new Date(),
        resolvedByUserId: adminUserId,
        resolution: ProviderReviewReportResolution.DISMISSED,
        resolutionNote: dto.resolutionNote?.trim() || null,
      },
    });
    if (closed.count === 0) {
      throw conflict(NO_OPEN_REVIEW_REPORT_CODE, 'Bu değerlendirme için açık bildirim yok.');
    }

    return this.getForAdmin(reviewId);
  }

  /**
   * Past the commit point: the row exists, so a failure here must not turn a
   * successful action into an error response. The mail service records
   * transport failures in NotificationLog itself; this catches a bug in the
   * composing code.
   */
  private async notifySafely(run: () => Promise<unknown>, reviewId: string) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Failed to send a review moderation notification for review ${reviewId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/**
 * The state each action requires, as a `where` fragment. Repeated on the
 * `updateMany` rather than checked on a prior read, because only the update
 * itself is atomic against a concurrent operator.
 */
function moderationPredicate(action: ProviderReviewModerationAction): Prisma.ProviderReviewWhereInput {
  switch (action) {
    case ProviderReviewModerationAction.REMOVE_COMMENT:
      return { comment: { not: null }, commentRemovedAt: null, removedAt: null };
    case ProviderReviewModerationAction.REMOVE_REVIEW:
      return { removedAt: null };
    case ProviderReviewModerationAction.RESTORE:
      return { OR: [{ removedAt: { not: null } }, { commentRemovedAt: { not: null } }] };
  }
}

function moderationData(
  action: ProviderReviewModerationAction,
  now: Date,
): Prisma.ProviderReviewUpdateManyMutationInput {
  switch (action) {
    case ProviderReviewModerationAction.REMOVE_COMMENT:
      return { commentRemovedAt: now };
    case ProviderReviewModerationAction.REMOVE_REVIEW:
      return { removedAt: now };
    case ProviderReviewModerationAction.RESTORE:
      return { removedAt: null, commentRemovedAt: null };
  }
}

/**
 * The partial unique index refusing a second open report. Prisma reports it
 * as P2002 with `meta.target: ['reviewId']`; older engines surfaced partial
 * indexes as an unknown request error naming the index, so both are caught.
 */
function isOpenReportConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes(ONE_OPEN_REPORT_INDEX)
  );
}
