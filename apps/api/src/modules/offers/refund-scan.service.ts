import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { OfferStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { calculateRefundEligibility } from './refund-policy';
import { refundOfferCreditInTransaction } from './offers.service';

type RefundScanOptions = {
  olderThanHours?: number | string;
  limit?: number | string;
};

type SkippedReason =
  | 'alreadyRefunded'
  | 'viewed'
  | 'notOldEnough'
  | 'noCreditSpend'
  | 'statusNotEligible';

const DEFAULT_OLDER_THAN_HOURS = 48;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const AUTOMATIC_REFUND_REASON = 'NOT_VIEWED_48H: Automatic refund scan';
const INELIGIBLE_STATUSES = [
  OfferStatus.ACCEPTED,
  OfferStatus.WITHDRAWN,
  OfferStatus.CANCELLED,
  OfferStatus.EXPIRED,
] as const;

const refundScanOfferSelect = {
  id: true,
  providerId: true,
  requestId: true,
  status: true,
  creditCost: true,
  creditSpentTransactionId: true,
  creditRefundedTransactionId: true,
  creditRefundedAt: true,
  submittedAt: true,
  viewedAt: true,
  acceptedAt: true,
} satisfies Prisma.OfferSelect;

type RefundScanOffer = Prisma.OfferGetPayload<{ select: typeof refundScanOfferSelect }>;

@Injectable()
export class RefundScanService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async dryRun(options: RefundScanOptions = {}) {
    const normalized = normalizeRefundScanOptions(options);
    const now = new Date();
    const cutoff = getCutoff(normalized.olderThanHours);
    const offers = await this.prisma.offer.findMany({
      where: automaticRefundCandidateWhere(cutoff),
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: normalized.limit,
      select: refundScanOfferSelect,
    });

    const items = [];

    for (const offer of offers) {
      const eligibility = getAutomaticRefundEligibility(offer, normalized.olderThanHours, now);
      if (eligibility.eligible) {
        items.push({
          offerId: offer.id,
          providerId: offer.providerId,
          requestId: offer.requestId,
          creditCost: offer.creditCost,
          submittedAt: offer.submittedAt,
          hoursSinceSubmitted: eligibility.hoursSinceSubmitted,
          reasonCode: eligibility.reasonCode,
          recommendedAction: eligibility.recommendedAction,
        });
      }
    }

    const skippedSummary = await this.getSkippedSummary(cutoff);
    const skippedCount = Object.values(skippedSummary).reduce((sum, count) => sum + count, 0);

    return {
      eligibleCount: items.length,
      skippedCount,
      items,
      skippedSummary,
    };
  }

  async execute(options: RefundScanOptions = {}) {
    const normalized = normalizeRefundScanOptions(options);
    const cutoff = getCutoff(normalized.olderThanHours);
    const offers = await this.prisma.offer.findMany({
      where: automaticRefundCandidateWhere(cutoff),
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: normalized.limit,
      select: { id: true },
    });

    const results = [];

    for (const offer of offers) {
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            const currentOffer = await tx.offer.findUnique({
              where: { id: offer.id },
              select: refundScanOfferSelect,
            });

            if (!currentOffer) {
              return { status: 'SKIPPED' as const, reason: 'Offer not found' };
            }

            const eligibility = getAutomaticRefundEligibility(
              currentOffer,
              normalized.olderThanHours,
              new Date(),
            );
            if (!eligibility.eligible) {
              return { status: 'SKIPPED' as const, reason: eligibility.reason };
            }

            await refundOfferCreditInTransaction(tx, currentOffer, AUTOMATIC_REFUND_REASON, {
              enforceAutomaticEligibility: true,
            });
            return { status: 'REFUNDED' as const, reason: AUTOMATIC_REFUND_REASON };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        results.push({ offerId: offer.id, ...result });
      } catch (err) {
        if (err instanceof ConflictException) {
          results.push({
            offerId: offer.id,
            status: 'SKIPPED' as const,
            reason: 'Offer is no longer eligible',
          });
          continue;
        }

        results.push({
          offerId: offer.id,
          status: 'FAILED' as const,
          reason: 'Refund execution failed',
        });
      }
    }

    const refunded = results.filter((result) => result.status === 'REFUNDED').length;
    const skipped = results.filter((result) => result.status === 'SKIPPED').length;

    return {
      processed: results.length,
      refunded,
      skipped,
      results,
    };
  }

  private async getSkippedSummary(cutoff: Date) {
    const [
      alreadyRefunded,
      viewed,
      noCreditSpend,
      statusNotEligible,
      notOldEnough,
    ] = await Promise.all([
      this.prisma.offer.count({
        where: {
          OR: [{ creditRefundedTransactionId: { not: null } }, { creditRefundedAt: { not: null } }],
        },
      }),
      this.prisma.offer.count({
        where: {
          ...notRefundedWhere,
          OR: [{ viewedAt: { not: null } }, { status: OfferStatus.VIEWED }],
        },
      }),
      this.prisma.offer.count({
        where: {
          ...notRefundedWhere,
          viewedAt: null,
          status: { not: OfferStatus.VIEWED },
          OR: [{ creditSpentTransactionId: null }, { creditCost: { lte: 0 } }],
        },
      }),
      this.prisma.offer.count({
        where: {
          ...notRefundedWhere,
          creditSpentTransactionId: { not: null },
          creditCost: { gt: 0 },
          viewedAt: null,
          status: { in: [...INELIGIBLE_STATUSES] },
        },
      }),
      this.prisma.offer.count({
        where: {
          ...notRefundedWhere,
          creditSpentTransactionId: { not: null },
          creditCost: { gt: 0 },
          viewedAt: null,
          status: { notIn: [OfferStatus.VIEWED, ...INELIGIBLE_STATUSES] },
          submittedAt: { gt: cutoff },
        },
      }),
    ]);

    return {
      alreadyRefunded,
      viewed,
      notOldEnough,
      noCreditSpend,
      statusNotEligible,
    };
  }
}

function getAutomaticRefundEligibility(
  offer: RefundScanOffer,
  olderThanHours: number,
  now: Date,
) {
  const policy = calculateRefundEligibility(offer, now);

  if (offer.creditRefundedTransactionId || offer.creditRefundedAt) {
    return skipped('alreadyRefunded', policy.hoursSinceSubmitted, 'Offer credit already refunded');
  }

  if (!offer.creditSpentTransactionId || offer.creditCost <= 0) {
    return skipped('noCreditSpend', policy.hoursSinceSubmitted, 'Offer has no credit spend');
  }

  if (offer.viewedAt || offer.status === OfferStatus.VIEWED) {
    return skipped('viewed', policy.hoursSinceSubmitted, 'Offer was viewed');
  }

  if (INELIGIBLE_STATUSES.includes(offer.status as (typeof INELIGIBLE_STATUSES)[number])) {
    return skipped('statusNotEligible', policy.hoursSinceSubmitted, `Offer status is ${offer.status}`);
  }

  if (policy.hoursSinceSubmitted === null || policy.hoursSinceSubmitted < olderThanHours) {
    return skipped('notOldEnough', policy.hoursSinceSubmitted, 'Offer is not old enough');
  }

  if (policy.recommendedAction !== 'FULL_REFUND' || policy.reasonCode !== 'NOT_VIEWED_48H') {
    return skipped(
      'statusNotEligible',
      policy.hoursSinceSubmitted,
      `Refund policy returned ${policy.recommendedAction}/${policy.reasonCode}`,
    );
  }

  return {
    eligible: true as const,
    hoursSinceSubmitted: policy.hoursSinceSubmitted,
    reasonCode: policy.reasonCode,
    recommendedAction: policy.recommendedAction,
  };
}

function skipped(skippedReason: SkippedReason, hoursSinceSubmitted: number | null, reason: string) {
  return {
    eligible: false as const,
    skippedReason,
    hoursSinceSubmitted,
    reason,
  };
}

function normalizeRefundScanOptions(options: RefundScanOptions) {
  const olderThanHours = readPositiveInteger(options.olderThanHours, 'olderThanHours');
  const limit = readPositiveInteger(options.limit, 'limit');

  if (limit !== undefined && limit > MAX_LIMIT) {
    throw new BadRequestException(`limit must be a positive integer up to ${MAX_LIMIT}`);
  }

  return {
    olderThanHours: olderThanHours ?? DEFAULT_OLDER_THAN_HOURS,
    limit: limit ?? DEFAULT_LIMIT,
  };
}

function readPositiveInteger(value: number | string | undefined, fieldName: string) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function getCutoff(olderThanHours: number) {
  const effectiveHours = Math.max(olderThanHours, DEFAULT_OLDER_THAN_HOURS);
  return new Date(Date.now() - effectiveHours * 60 * 60 * 1000);
}

function automaticRefundCandidateWhere(cutoff: Date): Prisma.OfferWhereInput {
  return {
    ...notRefundedWhere,
    creditSpentTransactionId: { not: null },
    creditCost: { gt: 0 },
    viewedAt: null,
    status: { notIn: [OfferStatus.VIEWED, ...INELIGIBLE_STATUSES] },
    submittedAt: { lte: cutoff },
  };
}

const notRefundedWhere = {
  creditRefundedTransactionId: null,
  creditRefundedAt: null,
} satisfies Prisma.OfferWhereInput;
