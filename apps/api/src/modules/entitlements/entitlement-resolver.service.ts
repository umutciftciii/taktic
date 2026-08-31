import { ConflictException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  CreditTransactionType,
  OfferEntitlementSource,
  OfferPackageType,
  Prisma,
  ProviderEntitlementStatus,
} from '@prisma/client';
import { CreditsService } from '../credits/credits.service';
import { istanbulDayStart } from './entitlement-period';

/** The 402 the offer flow has always answered with when nothing could pay. */
export const INSUFFICIENT_CREDIT_MESSAGE = 'Yetersiz teklif kredisi.';

export const DAILY_OFFER_LIMIT_CODE = 'UNLIMITED_DAILY_LIMIT_REACHED';

export type EntitlementDecision =
  | {
      source: typeof OfferEntitlementSource.UNLIMITED;
      entitlementId: string;
      /** Cost the offer records. Nothing is charged for it. */
      creditCost: number;
    }
  | {
      source: typeof OfferEntitlementSource.MONTHLY_QUOTA;
      entitlementId: string;
      creditCost: number;
    }
  | {
      source: typeof OfferEntitlementSource.ONE_TIME_CREDIT;
      entitlementId: null;
      creditCost: number;
      /** Read in the same serialisation window the charge happens in. */
      balanceBefore: number;
    };

export type ResolveInput = {
  providerId: string;
  categoryId: string;
  creditCost: number;
  now: Date;
};

/**
 * The one place that decides what a provider's next offer is paid for with.
 *
 * The order is fixed and total:
 *
 *   1. an active CATEGORY_UNLIMITED period whose snapshotted scope covers this
 *      request's category,
 *   2. an active MONTHLY_QUOTA period with enough quota left,
 *   3. the one-time credit balance — unchanged, including its 402,
 *   4. nothing, which is the same 402 this flow has always answered with.
 *
 * Two things it deliberately does *not* do:
 *
 * - It never relaxes another rule. Category status, the provider's own category
 *   binding, the one-offer-per-request unique index, the area match and the
 *   spam rules all run before this is ever called, and an unlimited period is
 *   not an exemption from any of them. Being unmetered is about the price of an
 *   offer, never about the right to send one.
 * - It never falls through after refusing. If the unlimited period that covers
 *   this category has hit its daily cap, the answer is that cap — not a silent
 *   charge against a balance the provider believed they were not spending.
 *
 * Both halves run inside the caller's Serializable transaction, so the read
 * that chose a right and the write that spent it cannot be separated by
 * anything.
 */
@Injectable()
export class EntitlementResolverService {
  constructor(@Inject(CreditsService) private readonly credits: CreditsService) {}

  /**
   * Chooses the right that will pay, and refuses if none can.
   *
   * Reads only. The matching write is {@link consume}, which re-checks
   * everything it is about to rely on.
   */
  async resolve(tx: Prisma.TransactionClient, input: ResolveInput): Promise<EntitlementDecision> {
    const unlimited = await this.findUnlimited(tx, input);
    if (unlimited) {
      await this.assertDailyLimit(tx, unlimited, input.now);

      return {
        source: OfferEntitlementSource.UNLIMITED,
        entitlementId: unlimited.id,
        creditCost: input.creditCost,
      };
    }

    const quota = await this.findQuota(tx, input);
    if (quota) {
      return {
        source: OfferEntitlementSource.MONTHLY_QUOTA,
        entitlementId: quota.id,
        creditCost: input.creditCost,
      };
    }

    const balanceBefore = await readCreditBalance(tx, input.providerId);
    if (balanceBefore < input.creditCost) {
      throw new HttpException(INSUFFICIENT_CREDIT_MESSAGE, HttpStatus.PAYMENT_REQUIRED);
    }

    return {
      source: OfferEntitlementSource.ONE_TIME_CREDIT,
      entitlementId: null,
      creditCost: input.creditCost,
      balanceBefore,
    };
  }

  /**
   * Spends what {@link resolve} chose, and returns the ledger row when there
   * was one.
   *
   * The quota decrement is a conditional UPDATE rather than a read-then-write:
   * two offers racing for a provider's last quota credit both see the same
   * remaining figure, and only the one whose `WHERE remainingQuota >= cost`
   * still holds is allowed to land. The loser gets a write conflict from the
   * Serializable transaction or a zero row count here, and either way it is
   * refused rather than granted an offer nothing paid for.
   */
  async consume(
    tx: Prisma.TransactionClient,
    decision: EntitlementDecision,
    context: { providerId: string; offerId: string; reason: string; now: Date },
  ): Promise<{ creditTransactionId: string | null }> {
    if (decision.source === OfferEntitlementSource.UNLIMITED) {
      // Nothing is spent. The offer's own entitlementId is the record that this
      // period covered it, and the daily cap is counted off those rows.
      return { creditTransactionId: null };
    }

    if (decision.source === OfferEntitlementSource.MONTHLY_QUOTA) {
      const updated = await tx.providerPackageEntitlement.updateMany({
        where: {
          id: decision.entitlementId,
          providerId: context.providerId,
          status: ProviderEntitlementStatus.ACTIVE,
          startAt: { lte: context.now },
          endAt: { gt: context.now },
          remainingQuota: { gte: decision.creditCost },
        },
        data: { remainingQuota: { decrement: decision.creditCost } },
      });

      if (updated.count !== 1) {
        // The quota went away between the read and the write. Refusing is the
        // only safe answer: granting here would be the one bug this whole
        // conditional update exists to make impossible.
        throw new HttpException(INSUFFICIENT_CREDIT_MESSAGE, HttpStatus.PAYMENT_REQUIRED);
      }

      return { creditTransactionId: null };
    }

    const transaction = await this.credits.createProviderCreditTransactionInTransaction(tx, {
      providerId: context.providerId,
      type: CreditTransactionType.OFFER_SPEND,
      amount: -decision.creditCost,
      reason: context.reason,
      referenceType: 'Offer',
      referenceId: context.offerId,
    });

    return { creditTransactionId: transaction.id };
  }

  /**
   * The active unlimited period covering this category, if there is one.
   *
   * Scope is matched against the snapshot written at purchase time, never
   * against the package's current scope and never by walking the live category
   * tree. A group that gains a child tomorrow does not widen a period sold
   * today.
   *
   * The ordering is the deterministic tie-break for the one case the checkout
   * guard cannot rule out — two overlapping unlimited periods bought
   * concurrently. Longest remaining period first, then newest, then id: a total
   * order over rows that always exists, so the same request always resolves to
   * the same period.
   */
  private findUnlimited(tx: Prisma.TransactionClient, input: ResolveInput) {
    return tx.providerPackageEntitlement.findFirst({
      where: {
        providerId: input.providerId,
        type: OfferPackageType.CATEGORY_UNLIMITED,
        status: ProviderEntitlementStatus.ACTIVE,
        startAt: { lte: input.now },
        endAt: { gt: input.now },
        scopes: { some: { categoryId: input.categoryId } },
      },
      orderBy: [{ endAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, dailyOfferLimitSnapshot: true, packageNameSnapshot: true },
    });
  }

  /**
   * The active quota period that should pay.
   *
   * Soonest-ending first: quota does not carry over, so spending the period
   * that is about to lapse before one with three weeks left is the only order
   * that does not throw the provider's money away.
   */
  private findQuota(tx: Prisma.TransactionClient, input: ResolveInput) {
    return tx.providerPackageEntitlement.findFirst({
      where: {
        providerId: input.providerId,
        type: OfferPackageType.MONTHLY_QUOTA,
        status: ProviderEntitlementStatus.ACTIVE,
        startAt: { lte: input.now },
        endAt: { gt: input.now },
        remainingQuota: { gte: input.creditCost },
      },
      orderBy: [{ endAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  }

  /**
   * The unlimited package's daily cap, counted off the offers this very period
   * paid for.
   *
   * Counted from the start of the Europe/Istanbul day, because that is the day
   * the provider is living in and the day every other timestamp on their screen
   * is rendered in.
   */
  private async assertDailyLimit(
    tx: Prisma.TransactionClient,
    entitlement: { id: string; dailyOfferLimitSnapshot: number | null },
    now: Date,
  ) {
    if (entitlement.dailyOfferLimitSnapshot === null) {
      return;
    }

    const usedToday = await tx.offer.count({
      where: {
        entitlementId: entitlement.id,
        submittedAt: { gte: istanbulDayStart(now) },
      },
    });

    if (usedToday >= entitlement.dailyOfferLimitSnapshot) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        code: DAILY_OFFER_LIMIT_CODE,
        message: `Limitsiz paketinizin günlük teklif sınırına ulaştınız (${entitlement.dailyOfferLimitSnapshot} teklif). Yarın tekrar deneyebilirsiniz.`,
        dailyOfferLimit: entitlement.dailyOfferLimitSnapshot,
      });
    }
  }
}

/**
 * The provider's balance, read the same way every other credit path reads it:
 * the newest ledger row's running total.
 */
async function readCreditBalance(tx: Prisma.TransactionClient, providerId: string) {
  const latest = await tx.providerCreditTransaction.findFirst({
    where: { providerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });

  return latest?.balanceAfter ?? 0;
}
