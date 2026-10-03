import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { OfferEntitlementSource, Prisma } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { OperationsSettingsService } from '../operations-settings/operations-settings.service';
import { UNVIEWED_OFFER_REFUND_REASON, calculateRefundEligibility } from './refund-policy';
import { CREDIT_BALANCE_LIMIT_EXCEEDED, isCreditBalanceLimitExceeded } from '../../common/credit-limits';
import { refundOfferCreditInTransaction } from './offers.service';

type UnviewedOfferRefundOptions = {
  limit?: number | string;
  /**
   * The operator who ran the scan by hand (`POST /offers/refund-scan/execute`),
   * written as `createdById` on every ledger row the run writes — the column a
   * manual refund already fills (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
   * The scheduler passes nothing, so its rows keep `createdById = null` and a
   * hand-run batch can be told apart from the automatic one.
   */
  actorId?: string | null;
};

type RefundScanPageOptions = {
  page?: number | string;
  pageSize?: number | string;
};

/**
 * The counts line a run of the refund leaves in `SchedulerRun.summary` — the
 * same words whether the scheduler or an operator ran it.
 */
export function refundRunSummary(result: {
  processed: number;
  refunded: number;
  skipped: number;
  results: Array<{ status: string }>;
}): string {
  const failed = result.results.filter((item) => item.status === 'FAILED').length;
  return `processed=${result.processed} refunded=${result.refunded} skipped=${result.skipped} failed=${failed}`;
}

/** The preview's page size when none is asked for, and the most one page holds. */
export const REFUND_SCAN_DEFAULT_PAGE_SIZE = 50;
export const REFUND_SCAN_MAX_PAGE_SIZE = 100;

type SkippedReason =
  | 'alreadyRefunded'
  | 'viewed'
  | 'adminDecision'
  | 'notOldEnough'
  | 'noCreditSpend'
  | 'outOfPolicy'
  | 'noSchedule';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The columns the policy reads, and only those.
 *
 * `status` is absent on purpose. Under this policy an offer's status decides
 * nothing: an unviewed offer that expired, was withdrawn or was rejected is
 * still an unviewed offer, and its credit still comes back. Leaving the column
 * out means no future edit can quietly reintroduce a status rule.
 *
 * `refundBlockedAt` is present for the opposite reason: eligibility must never
 * rest on `viewedAt` alone, because an administrator deciding on the customer's
 * behalf settles the credit without any customer ever opening the offer.
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
  // The offer's own clock. The worker reads this and never the live setting, so
  // an administrator changing the window today cannot move an offer created
  // yesterday — in either direction.
  unviewedRefundWindowHours: true,
  unviewedRefundEligibleAt: true,
  refundBlockedAt: true,
  refundBlockedReason: true,
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
 * that has spent a one-time credit, carries no `viewedAt`, and has reached its
 * own `unviewedRefundEligibleAt`, is refunded exactly once.
 *
 * That moment is a snapshot taken when the offer was created, and reading it
 * rather than the current setting is the whole design. An administrator may
 * change the window from the operations settings screen, but the change governs
 * offers created after it: an offer sold at 48 hours keeps 48 hours even if the
 * setting says 72 tomorrow, and — just as importantly — shortening the setting
 * cannot pay out early on an offer whose customer was promised longer.
 *
 * Late is safe, early is not. The worker refunds on the first run after each
 * offer's own moment, whenever that is; there is no caller-supplied window, so
 * no scheduler, admin screen or test can shorten one.
 */
@Injectable()
export class UnviewedOfferRefundService {
  private readonly logger = new Logger(UnviewedOfferRefundService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
    @Inject(OperationsSettingsService)
    private readonly operationsSettings: OperationsSettingsService,
  ) {}

  /**
   * The preview of what the worker would refund, one page at a time
   * (API-REFUND-SCAN-PAGINATION-001).
   *
   * `total`, the page and `totalCreditCost` are read from one predicate —
   * {@link refundCandidateWhere}, the very one `execute` and the dashboard's
   * "iade adayı" count use — inside one REPEATABLE READ snapshot, so the total
   * and the rows cannot disagree with each other however the table moves
   * between the statements. The previous answer was the first `limit` rows
   * and their count, which stopped being the whole set at 100.
   *
   * Oldest submission first, the id breaking ties: the order `execute` works
   * through, so page 1 is the next batch a run would take.
   */
  async dryRun(options: RefundScanPageOptions = {}) {
    const { page, pageSize } = normalizeScanPaging(options);
    const now = new Date();
    const where = refundCandidateWhere(now);
    const [total, credit, offers] = await this.prisma.$transaction(
      [
        this.prisma.offer.count({ where }),
        this.prisma.offer.aggregate({ where, _sum: { creditCost: true } }),
        this.prisma.offer.findMany({
          where,
          orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: candidateOfferSelect,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const items = offers.map((offer) => {
      // The predicate is the policy's eligibility restated as a query, so every
      // row it returns is eligible. The verdict is still the policy's own, per
      // row, so a disagreement would show on the row rather than vanish from a
      // page whose total already counted it.
      const eligibility = getRefundEligibility(offer, now);
      if (!eligibility.eligible) {
        this.logger.warn(`Refund scan candidate ${offer.id} failed the policy check (${eligibility.skippedReason})`);
      }
      return {
        offerId: offer.id,
        providerId: offer.providerId,
        requestId: offer.requestId,
        creditCost: offer.creditCost,
        submittedAt: offer.submittedAt,
        hoursSinceSubmitted: eligibility.hoursSinceSubmitted,
        // Per item, because two offers in the same scan can carry two
        // different windows once the setting has been changed.
        windowHours: offer.unviewedRefundWindowHours,
        eligibleAt: offer.unviewedRefundEligibleAt,
        reasonCode: eligibility.eligible ? eligibility.reasonCode : eligibility.skippedReason,
        recommendedAction: eligibility.eligible ? eligibility.recommendedAction : 'NO_REFUND',
      };
    });

    const [skippedSummary, currentWindowHours] = await Promise.all([
      this.getSkippedSummary(now),
      this.operationsSettings.getUnviewedOfferRefundWindowHours(),
    ]);
    const skippedCount = Object.values(skippedSummary).reduce((sum, count) => sum + count, 0);

    return {
      // The window a *new* offer is created with, not the window this scan
      // applied: the scan applied each offer's own snapshot, which the items
      // report individually.
      currentWindowHours,
      /** Every eligible offer, not this page's. */
      total,
      /** The same number under its older name, kept for existing readers. */
      eligibleCount: total,
      /** The credit every eligible offer would give back, across all pages. */
      totalCreditCost: credit._sum.creditCost ?? 0,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
      skippedCount,
      items,
      skippedSummary,
    };
  }

  /**
   * How many offers the worker would refund right now — the dashboard's
   * "iade adayı" and the scan's `total`, from one predicate.
   */
  countCandidates(now = new Date()): Promise<number> {
    return this.prisma.offer.count({ where: refundCandidateWhere(now) });
  }

  async execute(options: UnviewedOfferRefundOptions = {}) {
    const limit = normalizeLimit(options.limit);
    const offers = await this.prisma.offer.findMany({
      where: refundCandidateWhere(new Date()),
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
              { createdById: options.actorId ?? null },
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

        // API-HARDENING-001: giving this credit back would take the provider's
        // balance past the ledger's integer column. Nothing was written (the
        // refusal comes before the ledger row, and the transaction rolled
        // back), the offer is still eligible, and a later scan refunds it once
        // the balance has room. Skipped, not FAILED: nothing is broken.
        if (isCreditBalanceLimitExceeded(err)) {
          results.push({
            offerId: offer.id,
            status: 'SKIPPED' as const,
            reason: CREDIT_BALANCE_LIMIT_EXCEEDED,
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
  private async getSkippedSummary(now: Date) {
    const [
      alreadyRefunded,
      viewed,
      noCreditSpend,
      notOldEnough,
      outOfPolicy,
      adminDecision,
      noSchedule,
    ] = await Promise.all([
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
            refundBlockedAt: null,
            creditSpentTransactionId: { not: null },
            creditCost: { gt: 0 },
            unviewedRefundEligibleAt: { gt: now },
          },
        }),
        this.prisma.offer.count({ where: { unviewedRefundPolicy: false } }),
        this.prisma.offer.count({
          where: { ...inPolicyUnrefundedWhere, viewedAt: null, refundBlockedAt: { not: null } },
        }),
        // Its own bucket rather than a silent share of "not old enough": an
        // in-policy offer with no eligibility moment is never paid, and an
        // operator has to be able to see that it exists.
        this.prisma.offer.count({
          where: {
            ...inPolicyUnrefundedWhere,
            viewedAt: null,
            refundBlockedAt: null,
            creditSpentTransactionId: { not: null },
            creditCost: { gt: 0 },
            unviewedRefundEligibleAt: null,
          },
        }),
      ]);

    return {
      alreadyRefunded,
      viewed,
      adminDecision,
      notOldEnough,
      noCreditSpend,
      outOfPolicy,
      noSchedule,
    };
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

  if (offer.refundBlockedAt) {
    return skipped(
      'adminDecision',
      policy.hoursSinceSubmitted,
      `Refund blocked: ${offer.refundBlockedReason ?? 'unknown reason'}`,
    );
  }

  if (!offer.unviewedRefundEligibleAt) {
    return skipped(
      'noSchedule',
      policy.hoursSinceSubmitted,
      'Offer carries no refund eligibility moment',
    );
  }

  if (offer.unviewedRefundEligibleAt.getTime() > now.getTime()) {
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
 * The offers whose own eligibility moment has arrived.
 *
 * There is no window parameter here and there never was one: a caller-supplied
 * window could only ever be used to refund sooner than the promise allows.
 * There is no live setting here either — each row carries the moment it was
 * created with, and `lte` never matches NULL, so an in-policy offer that
 * somehow has no schedule is skipped rather than paid.
 */
/**
 * The offers the worker refunds now: the refund policy's eligibility
 * (`calculateRefundEligibility`) restated as one query. The single source for
 * the scan's preview and total, the run's batch and the dashboard's count
 * (API-REFUND-SCAN-PAGINATION-001) — a number on one screen and a list on
 * another cannot drift apart while all three read this.
 */
export function refundCandidateWhere(now: Date): Prisma.OfferWhereInput {
  return {
    // A period package is never refunded (PERIOD_PACKAGE_NOT_REFUNDABLE). Such
    // an offer spends no one-time credit, so the clause below already leaves
    // it out; stated here as well so the query is the policy without relying
    // on that, and the total cannot count an offer the policy refuses.
    OR: [{ entitlementSource: null }, { entitlementSource: OfferEntitlementSource.ONE_TIME_CREDIT }],
    ...inPolicyUnrefundedWhere,
    creditSpentTransactionId: { not: null },
    creditCost: { gt: 0 },
    viewedAt: null,
    // Beside `viewedAt`, never instead of it: an administrator's accept or
    // reject on the customer's behalf settles the credit without any customer
    // opening the offer, and the worker has to see that.
    refundBlockedAt: null,
    unviewedRefundEligibleAt: { lte: now },
  };
}

const inPolicyUnrefundedWhere = {
  unviewedRefundPolicy: true,
  creditRefundedTransactionId: null,
  creditRefundedAt: null,
} satisfies Prisma.OfferWhereInput;

function normalizeScanPaging(options: RefundScanPageOptions) {
  const page = readPositiveInt(options.page, 1, 'page');
  const pageSize = readPositiveInt(options.pageSize, REFUND_SCAN_DEFAULT_PAGE_SIZE, 'pageSize');
  if (pageSize > REFUND_SCAN_MAX_PAGE_SIZE) {
    throw new BadRequestException(`pageSize must be a positive integer up to ${REFUND_SCAN_MAX_PAGE_SIZE}`);
  }
  return { page, pageSize };
}

function readPositiveInt(value: number | string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  return parsed;
}
