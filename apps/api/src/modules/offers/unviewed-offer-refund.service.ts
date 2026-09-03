import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  UNVIEWED_OFFER_REFUND_REASON,
  UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
  calculateRefundEligibility,
} from './refund-policy';
import { refundOfferCreditInTransaction } from './offers.service';

type UnviewedOfferRefundOptions = {
  limit?: number | string;
};

type SkippedReason = 'alreadyRefunded' | 'viewed' | 'notOldEnough' | 'noCreditSpend' | 'outOfPolicy';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The columns the policy reads, and only those.
 *
 * `status` is absent on purpose. Under this policy an offer's status decides
 * nothing: an unviewed offer that expired, was withdrawn or was rejected is
 * still an unviewed offer, and its credit still comes back. Leaving the column
 * out means no future edit can quietly reintroduce a status rule.
 */
const candidateOfferSelect = {
  id: true,
  providerId: true,
  requestId: true,
  creditCost: true,
  creditSpentTransactionId: true,
  creditRefundedTransactionId: true,
  creditRefundedAt: true,
  submittedAt: true,
  viewedAt: true,
  unviewedRefundPolicy: true,
  // The scan already filters on a non-null creditSpentTransactionId, which no
  // period-package offer has, so this changes no row it selects. It is here so
  // the policy verdict written into the report names the real reason.
  entitlementSource: true,
} satisfies Prisma.OfferSelect;

type CandidateOffer = Prisma.OfferGetPayload<{ select: typeof candidateOfferSelect }>;

/**
 * Pays back the credit of an offer the customer never opened.
 *
 * The whole rule: an offer inside the policy (see `Offer.unviewedRefundPolicy`)
 * that has spent a one-time credit, carries no `viewedAt`, and was submitted at
 * least 48 hours ago, is refunded exactly once. Nothing else is refunded, by
 * this service or by any other — the manual admin refund it used to sit beside
 * was removed with this policy, because a hand-made refund is a second answer
 * to a question that now has one.
 *
 * Late is safe, early is not. The worker refunds on the first run after the
 * window closes, whenever that is; the cutoff is computed from a fixed 48 hours
 * rather than from a parameter, so no caller — scheduler, admin screen or test —
 * can shorten it and pay out on an offer the customer could still open.
 */
@Injectable()
export class UnviewedOfferRefundService {
  private readonly logger = new Logger(UnviewedOfferRefundService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  async dryRun(options: UnviewedOfferRefundOptions = {}) {
    const limit = normalizeLimit(options.limit);
    const now = new Date();
    const cutoff = getCutoff(now);
    const offers = await this.prisma.offer.findMany({
      where: refundCandidateWhere(cutoff),
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: candidateOfferSelect,
    });

    const items = [];

    for (const offer of offers) {
      const eligibility = getRefundEligibility(offer, now);
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
      windowHours: UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
      eligibleCount: items.length,
      skippedCount,
      items,
      skippedSummary,
    };
  }

  async execute(options: UnviewedOfferRefundOptions = {}) {
    const limit = normalizeLimit(options.limit);
    const cutoff = getCutoff(new Date());
    const offers = await this.prisma.offer.findMany({
      where: refundCandidateWhere(cutoff),
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    const results = [];

    for (const offer of offers) {
      try {
        // runSerializable rather than a bare $transaction: two workers reaching
        // the same offer make PostgreSQL abort one with a write conflict, and a
        // conflict is not a failure — the loser replays, sees the refund already
        // recorded and skips. Without the retry it would be reported as FAILED
        // and an operator would go looking for a bug that is not there.
        const result = await runSerializable(
          this.prisma,
          async (tx) => {
            // Re-read inside the transaction. The list above was assembled
            // outside it and a customer may have opened the offer since; the
            // eligibility that decides a payment is the one computed from the
            // row this transaction can see.
            const currentOffer = await tx.offer.findUnique({
              where: { id: offer.id },
              select: candidateOfferSelect,
            });

            if (!currentOffer) {
              return { status: 'SKIPPED' as const, reason: 'Offer not found' };
            }

            const eligibility = getRefundEligibility(currentOffer, new Date());
            if (!eligibility.eligible) {
              return { status: 'SKIPPED' as const, reason: eligibility.reason };
            }

            const { refundTransaction } = await refundOfferCreditInTransaction(
              tx,
              currentOffer,
              UNVIEWED_OFFER_REFUND_REASON,
            );

            return {
              status: 'REFUNDED' as const,
              reason: UNVIEWED_OFFER_REFUND_REASON,
              refundTransactionId: refundTransaction.id,
            };
          },
          { label: 'unviewedOfferRefund.execute' },
        );

        // Outside the transaction, and only for a refund that really happened.
        // The message is keyed on the ledger row, so a re-run of the scan that
        // finds nothing left to refund also mails nobody.
        if (result.status === 'REFUNDED') {
          try {
            await this.mail.sendCreditRefunded(result.refundTransactionId);
          } catch (error) {
            this.logger.error(
              `Failed to send the refund notification for offer ${offer.id}`,
              error instanceof Error ? error.stack : String(error),
            );
          }
        }

        results.push({ offerId: offer.id, ...result });
      } catch (err) {
        // A 409 is the expected outcome of a race, not a failure: another run,
        // or the database's own one-refund-per-offer index, got there first.
        if (err instanceof ConflictException) {
          results.push({
            offerId: offer.id,
            status: 'SKIPPED' as const,
            reason: 'Offer is no longer eligible',
          });
          continue;
        }

        this.logger.error(
          `Refund execution failed for offer ${offer.id}`,
          err instanceof Error ? err.stack : String(err),
        );

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

  /**
   * Why the offers this scan did not pick up were left alone. Counted over the
   * policy's own population, so an offer written before the policy shipped is
   * reported as out of scope rather than padding one of the other buckets.
   */
  private async getSkippedSummary(cutoff: Date) {
    const [alreadyRefunded, viewed, noCreditSpend, notOldEnough, outOfPolicy] = await Promise.all([
      this.prisma.offer.count({
        where: {
          unviewedRefundPolicy: true,
          OR: [{ creditRefundedTransactionId: { not: null } }, { creditRefundedAt: { not: null } }],
        },
      }),
      this.prisma.offer.count({
        where: { ...inPolicyUnrefundedWhere, viewedAt: { not: null } },
      }),
      this.prisma.offer.count({
        where: {
          ...inPolicyUnrefundedWhere,
          viewedAt: null,
          OR: [{ creditSpentTransactionId: null }, { creditCost: { lte: 0 } }],
        },
      }),
      this.prisma.offer.count({
        where: {
          ...inPolicyUnrefundedWhere,
          viewedAt: null,
          creditSpentTransactionId: { not: null },
          creditCost: { gt: 0 },
          submittedAt: { gt: cutoff },
        },
      }),
      this.prisma.offer.count({ where: { unviewedRefundPolicy: false } }),
    ]);

    return { alreadyRefunded, viewed, notOldEnough, noCreditSpend, outOfPolicy };
  }
}

function getRefundEligibility(offer: CandidateOffer, now: Date) {
  const policy = calculateRefundEligibility(offer, now);

  // The policy verdict is the decision; this only translates a refusal into the
  // bucket the report names it by. Ordered from the most settled fact outwards,
  // so an already-refunded offer never reads as "not old enough".
  if (offer.creditRefundedTransactionId || offer.creditRefundedAt) {
    return skipped('alreadyRefunded', policy.hoursSinceSubmitted, 'Offer credit already refunded');
  }

  if (!offer.unviewedRefundPolicy) {
    return skipped(
      'outOfPolicy',
      policy.hoursSinceSubmitted,
      'Offer predates the unviewed-offer refund policy',
    );
  }

  if (!offer.creditSpentTransactionId || offer.creditCost <= 0) {
    return skipped('noCreditSpend', policy.hoursSinceSubmitted, 'Offer has no credit spend');
  }

  if (offer.viewedAt) {
    return skipped('viewed', policy.hoursSinceSubmitted, 'Offer was viewed');
  }

  if (
    policy.hoursSinceSubmitted === null ||
    policy.hoursSinceSubmitted < UNVIEWED_OFFER_REFUND_WINDOW_HOURS
  ) {
    return skipped('notOldEnough', policy.hoursSinceSubmitted, 'Offer is not old enough');
  }

  if (policy.recommendedAction !== 'FULL_REFUND' || policy.reasonCode !== UNVIEWED_OFFER_REFUND_REASON) {
    return skipped(
      'outOfPolicy',
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

function normalizeLimit(value: number | string | undefined) {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }

  if (parsed > MAX_LIMIT) {
    throw new BadRequestException(`limit must be a positive integer up to ${MAX_LIMIT}`);
  }

  return parsed;
}

/**
 * The 48-hour boundary, derived from the constant and from nothing else.
 *
 * There is no parameter here and there was one before. A caller-supplied window
 * can only ever be used to refund sooner than the promise allows, which would
 * pay for an offer the customer still had time to open.
 */
function getCutoff(now: Date) {
  return new Date(now.getTime() - UNVIEWED_OFFER_REFUND_WINDOW_HOURS * 60 * 60 * 1000);
}

function refundCandidateWhere(cutoff: Date): Prisma.OfferWhereInput {
  return {
    ...inPolicyUnrefundedWhere,
    creditSpentTransactionId: { not: null },
    creditCost: { gt: 0 },
    viewedAt: null,
    submittedAt: { lte: cutoff },
  };
}

const inPolicyUnrefundedWhere = {
  unviewedRefundPolicy: true,
  creditRefundedTransactionId: null,
  creditRefundedAt: null,
} satisfies Prisma.OfferWhereInput;
