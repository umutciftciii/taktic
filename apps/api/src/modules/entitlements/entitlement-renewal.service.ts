import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EntitlementRenewalFailureCode,
  EntitlementRenewalStatus,
  OfferPackageType,
  Prisma,
  ProviderEntitlementStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PaymentProviderPort,
  StoredPaymentChargeError,
} from '../payments/payment-provider.port';
import { nextPeriodStart, periodEnd } from './entitlement-period';

/**
 * How long one runner's claim on a period lasts. A second runner that finds a
 * claim newer than this leaves the period alone.
 */
export const RENEWAL_CLAIM_TTL_MS = 10 * 60 * 1000;

/** How many periods one pass will look at. */
const DEFAULT_RENEWAL_BATCH = 100;

export type RenewalRunSummary = {
  examined: number;
  renewed: number;
  expired: number;
  failed: number;
  unsupported: number;
};

/**
 * What happens to a period when its clock runs out.
 *
 * Three outcomes, and the ordering between them is the whole of the money
 * safety in this feature:
 *
 * 1. Auto-renew off — the period simply expires. No charge is attempted, no
 *    attempt row is written, because nothing was attempted.
 * 2. Auto-renew on but the money cannot be taken — an attempt row is written
 *    with the reason, and the period goes to PAST_DUE. **Access is not
 *    extended.** `endAt` is never touched on this path; that is what makes a
 *    failed payment unable to buy a single extra hour.
 * 3. Auto-renew on and the charge succeeded — a new period begins, `periodIndex`
 *    increments, and a MONTHLY_QUOTA's quota is *reset* from its snapshot rather
 *    than added to, because unused quota does not carry over.
 *
 * ## Not charging twice
 *
 * Three independent guards, because a duplicate charge is the one failure here
 * that costs somebody real money:
 *
 * - The scheduler will not start a second pass while one is running.
 * - Each period is claimed with a conditional UPDATE before the provider is
 *   called. A second runner sees a claim younger than {@link RENEWAL_CLAIM_TTL_MS}
 *   and skips the row entirely.
 * - `idempotencyKey` is `<entitlementId>:<periodIndex>`, stable for the period,
 *   so a payment provider that honours idempotency keys refuses the second
 *   charge on its own side.
 *
 * And behind all three, the partial unique index
 * `PackageRenewalAttempt_one_success_per_period` makes a second *granted*
 * period unrepresentable even if every guard above were bypassed.
 */
@Injectable()
export class EntitlementRenewalService {
  private readonly logger = new Logger('EntitlementRenewal');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentProviderPort) private readonly payments: PaymentProviderPort,
  ) {}

  async runDueRenewals(
    options: { now?: Date; limit?: number } = {},
  ): Promise<RenewalRunSummary> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? DEFAULT_RENEWAL_BATCH;

    const due = await this.prisma.providerPackageEntitlement.findMany({
      where: {
        status: ProviderEntitlementStatus.ACTIVE,
        endAt: { lte: now },
        type: { not: OfferPackageType.ONE_TIME_CREDITS },
      },
      orderBy: [{ endAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: dueSelect,
    });

    const summary: RenewalRunSummary = {
      examined: due.length,
      renewed: 0,
      expired: 0,
      failed: 0,
      unsupported: 0,
    };

    for (const entitlement of due) {
      const outcome = await this.settleOne(entitlement, now);
      summary[outcome] += 1;
    }

    return summary;
  }

  private async settleOne(
    entitlement: DueEntitlement,
    now: Date,
  ): Promise<'renewed' | 'expired' | 'failed' | 'unsupported'> {
    if (!entitlement.autoRenewEnabled) {
      await this.expire(entitlement.id, now);
      return 'expired';
    }

    if (!(await this.claim(entitlement, now))) {
      // Another runner owns this period. Not an outcome, and deliberately
      // counted as "expired" only if that runner decides so — this pass reports
      // it as failed-to-progress so the number never overstates what happened.
      return 'failed';
    }

    const capability = this.payments.capabilities;
    if (!capability.automaticRenewal || !this.payments.chargeStoredPaymentMethod) {
      await this.recordFailure(
        entitlement,
        now,
        EntitlementRenewalStatus.UNSUPPORTED,
        EntitlementRenewalFailureCode.PROVIDER_UNSUPPORTED,
        null,
      );
      return 'unsupported';
    }

    if (!entitlement.paymentMethodReference) {
      await this.recordFailure(
        entitlement,
        now,
        EntitlementRenewalStatus.FAILED,
        EntitlementRenewalFailureCode.PAYMENT_METHOD_MISSING,
        null,
      );
      return 'failed';
    }

    let charged: { providerTransactionRef: string };
    try {
      charged = await this.payments.chargeStoredPaymentMethod({
        entitlementId: entitlement.id,
        providerId: entitlement.providerId,
        paymentMethodReference: entitlement.paymentMethodReference,
        priceAmount: entitlement.priceAmountSnapshot,
        currency: entitlement.currencySnapshot,
        idempotencyKey: `${entitlement.id}:${entitlement.periodIndex + 1}`,
      });
    } catch (error) {
      await this.recordFailure(
        entitlement,
        now,
        EntitlementRenewalStatus.FAILED,
        readFailureCode(error),
        null,
      );
      return 'failed';
    }

    try {
      await this.grantNextPeriod(entitlement, now, charged.providerTransactionRef);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The partial unique index refused a second period for this index.
        // Something already granted it; this runner must not grant another.
        this.logger.warn(
          `renewal for entitlement ${entitlement.id} period ${entitlement.periodIndex + 1} was already granted`,
        );
        return 'failed';
      }

      throw error;
    }

    return 'renewed';
  }

  /**
   * Takes the period, so a concurrent runner leaves it alone.
   *
   * A conditional UPDATE rather than a lock: the row is claimed only if nobody
   * else claimed it inside the TTL, and `updateMany` reports how many rows
   * matched, so losing the race is observable rather than silent.
   */
  private async claim(entitlement: DueEntitlement, now: Date) {
    const cutoff = new Date(now.getTime() - RENEWAL_CLAIM_TTL_MS);

    const claimed = await this.prisma.providerPackageEntitlement.updateMany({
      where: {
        id: entitlement.id,
        periodIndex: entitlement.periodIndex,
        status: ProviderEntitlementStatus.ACTIVE,
        endAt: { lte: now },
        OR: [{ lastRenewalAttemptAt: null }, { lastRenewalAttemptAt: { lt: cutoff } }],
      },
      data: { lastRenewalAttemptAt: now },
    });

    return claimed.count === 1;
  }

  private expire(entitlementId: string, now: Date) {
    return this.prisma.providerPackageEntitlement.updateMany({
      where: { id: entitlementId, status: ProviderEntitlementStatus.ACTIVE, endAt: { lte: now } },
      data: {
        status: ProviderEntitlementStatus.EXPIRED,
      },
    });
  }

  /**
   * Writes the attempt and moves the period to PAST_DUE.
   *
   * `endAt` is deliberately absent from the update. A failed renewal is exactly
   * as long as the period the provider paid for, and not one second longer.
   */
  private async recordFailure(
    entitlement: DueEntitlement,
    now: Date,
    status: EntitlementRenewalStatus,
    failureCode: EntitlementRenewalFailureCode,
    providerTransactionRef: string | null,
  ) {
    await this.prisma.$transaction([
      this.prisma.packageRenewalAttempt.create({
        data: {
          entitlementId: entitlement.id,
          periodIndex: entitlement.periodIndex + 1,
          status,
          failureCode,
          paymentProvider: this.payments.kind,
          providerTransactionRef,
        },
      }),
      this.prisma.providerPackageEntitlement.update({
        where: { id: entitlement.id },
        data: {
          status: ProviderEntitlementStatus.PAST_DUE,
          lastRenewalAttemptAt: now,
          lastRenewalFailureCode: failureCode,
        },
      }),
    ]);

    this.logger.warn(
      `renewal for entitlement ${entitlement.id} did not proceed: ${status}/${failureCode}`,
    );
  }

  /**
   * The successful path: one new period on the same row.
   *
   * The attempt row and the new period are written together, so an audit trail
   * that says a period was bought always has the period beside it.
   */
  private grantNextPeriod(
    entitlement: DueEntitlement,
    chargedAt: Date,
    providerTransactionRef: string,
  ) {
    const startAt = nextPeriodStart(chargedAt, entitlement.endAt);
    const endAt = periodEnd(startAt, entitlement.periodDaysSnapshot);

    return this.prisma.$transaction([
      this.prisma.packageRenewalAttempt.create({
        data: {
          entitlementId: entitlement.id,
          periodIndex: entitlement.periodIndex + 1,
          status: EntitlementRenewalStatus.SUCCEEDED,
          paymentProvider: this.payments.kind,
          providerTransactionRef,
        },
      }),
      this.prisma.providerPackageEntitlement.update({
        where: { id: entitlement.id },
        data: {
          periodIndex: entitlement.periodIndex + 1,
          startAt,
          endAt,
          status: ProviderEntitlementStatus.ACTIVE,
          // Reset, never topped up: unused quota does not carry over.
          remainingQuota:
            entitlement.type === OfferPackageType.MONTHLY_QUOTA
              ? entitlement.quotaCreditsSnapshot
              : null,
          lastRenewalAttemptAt: chargedAt,
          lastRenewalFailureCode: null,
        },
      }),
    ]);
  }
}

const dueSelect = {
  id: true,
  providerId: true,
  type: true,
  periodIndex: true,
  startAt: true,
  endAt: true,
  periodDaysSnapshot: true,
  quotaCreditsSnapshot: true,
  priceAmountSnapshot: true,
  currencySnapshot: true,
  autoRenewEnabled: true,
  paymentMethodReference: true,
} satisfies Prisma.ProviderPackageEntitlementSelect;

type DueEntitlement = Prisma.ProviderPackageEntitlementGetPayload<{ select: typeof dueSelect }>;

function readFailureCode(error: unknown): EntitlementRenewalFailureCode {
  if (error instanceof StoredPaymentChargeError) {
    return EntitlementRenewalFailureCode[error.failureCode];
  }

  return EntitlementRenewalFailureCode.PROVIDER_UNAVAILABLE;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
