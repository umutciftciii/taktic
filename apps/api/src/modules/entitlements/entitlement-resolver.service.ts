import { ConflictException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  MatchRoundSource,
  OfferEntitlementSource,
  OfferPackageType,
  Prisma,
  PromoConsumptionSource,
  ProviderEntitlementStatus,
} from '@prisma/client';
import {
  debitWallet,
  readUnsweptExpiredPromoCredits,
  WalletDebitRefused,
} from '../credits/promo-credit-ledger';
import {
  claimAllowanceSlot,
  isShowcaseAllowanceVoided,
  readShowcaseAllowance,
  recordAllowanceUsage,
  type ShowcaseAllowanceState,
} from '../offer-allowances/offer-allowance-ledger';
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
    }
  | {
      source: typeof OfferEntitlementSource.SHOWCASE_PLACEMENT;
      entitlementId: null;
      /**
       * Always zero: one of the placement's bounded free offers pays
       * (CAMPAIGN-ENTITLEMENT-001). Not "the placement makes every answer
       * free" any more — that unconditional branch is gone.
       */
      creditCost: 0;
      /** The grant a slot will be claimed from, as read in this transaction. */
      allowance: ShowcaseAllowanceState;
    };

/**
 * The slot a free offer was paid from, returned by {@link EntitlementResolverService.consume}
 * so the caller can report it after the commit.
 */
export type AllowanceUsageReceipt = {
  grantId: string;
  placementId: string;
  ordinal: number;
  quotaTotal: number;
};

/**
 * The slot the resolver chose had gone by the time the offer tried to spend it.
 *
 * Under the offer's Serializable transaction a concurrent claim normally
 * surfaces as a serialization failure and a replay instead; this is the same
 * fact reached without one. The caller answers it as a changed price — never
 * by quietly charging an offer the provider was shown as free.
 */
export class ShowcaseAllowanceUnavailable extends Error {
  constructor() {
    super('The vitrin allowance slot was claimed concurrently');
    this.name = 'ShowcaseAllowanceUnavailable';
  }
}

export type ResolveInput = {
  providerId: string;
  categoryId: string;
  creditCost: number;
  now: Date;
  /**
   * The provider this request is reserved for, when it is reserved for one.
   *
   * Read straight off `ServiceRequest.directShowcaseProviderId` by the caller
   * and passed through unchanged. NULL for every ordinary marketplace request,
   * which is what keeps the four existing branches exactly as they were.
   */
  directShowcaseProviderId?: string | null;
  /**
   * `ServiceRequest.showcaseLeadId` and the current round's source. Together
   * with the gate above they are what binds an answer to one placement's
   * allowance (CAMPAIGN-ENTITLEMENT-001). Absent on every marketplace request.
   */
  showcaseLeadId?: string | null;
  roundSource?: MatchRoundSource | null;
};

/**
 * What the provider's next offer on a request would cost, without spending
 * anything — the figure a direct-lead offer form shows and sends back as its
 * expected cost.
 */
export type OfferCostPreview = {
  /** Which right would pay, or why nothing would. */
  kind:
    | 'SHOWCASE_ALLOWANCE'
    | 'UNLIMITED'
    | 'MONTHLY_QUOTA'
    | 'CREDITS'
    | 'INSUFFICIENT_CREDITS'
    | 'DAILY_LIMIT';
  /** The cost the offer would record — the value to send as `expectedCreditCost`. */
  creditCost: number;
  /** The category's own price, for the "normally X kredi" line. */
  categoryCreditCost: number;
  /** The bound vitrin allowance, when this is the provider's own direct lead. */
  allowance: { quotaTotal: number; quotaUsed: number; remaining: number } | null;
  /**
   * SHOWCASE-ALLOWANCE-004 — the direct lead's run *had* free offers and a
   * super admin voided what was left. `allowance` is then null (a VOID grant
   * pays for nothing) and this says why, so the form can say "cancelled"
   * rather than "ran out".
   */
  allowanceVoided: boolean;
};

/**
 * The one place that decides what a provider's next offer is paid for with.
 *
 * The order is fixed and total (CAMPAIGN-ENTITLEMENT-001):
 *
 *   1. an active CATEGORY_UNLIMITED period whose snapshotted scope covers this
 *      request's category — first, so an unmetered period never burns one of
 *      a placement's three finite free offers,
 *   2. a free slot of the vitrin allowance this direct lead is bound to (the
 *      provider's own gated lead, its placement's ACTIVE grant, a slot left),
 *   3. an active MONTHLY_QUOTA period with enough quota left,
 *   4. the one-time credit balance — unchanged, including its 402,
 *   5. nothing, which is the same 402 this flow has always answered with.
 *
 * One exception keeps a direct lead answerable: when the unlimited period that
 * covers the category has hit its daily cap and a free vitrin slot is bound to
 * this lead, the slot pays instead of the cap refusing — the cap exists to
 * meter unlimited offering, not to stop a business answering somebody who
 * wrote to them through a placement they paid for.
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
 *   (The vitrin slot above is not a fall-through to a charge: it is free.)
 *
 * Both halves run inside the caller's Serializable transaction, so the read
 * that chose a right and the write that spent it cannot be separated by
 * anything.
 */
@Injectable()
export class EntitlementResolverService {
  // CAMPAIGN-CREDIT-POLICY-001: the one-time-credit charge goes through the
  // shared wallet debit primitive; nothing here needs CreditsService any more.
  constructor() {}

  /**
   * Chooses the right that will pay, and refuses if none can.
   *
   * Reads only. The matching write is {@link consume}, which re-checks
   * everything it is about to rely on.
   */
  async resolve(tx: Prisma.TransactionClient, input: ResolveInput): Promise<EntitlementDecision> {
    /*
     * The vitrin allowance this answer is bound to, if it is the provider's
     * own gated direct lead (CAMPAIGN-ENTITLEMENT-001).
     *
     * Before this change the gate alone made every answer free, for ever. Now
     * the placement carries a bounded number of free offers and the gate only
     * says *which* placement's allowance may pay: the lead names it, so a slot
     * can never be spent on another card's lead, another run's lead, or after
     * a fallback has cleared the gate (RELEASE, REL-002 R2+), when the request
     * is an ordinary marketplace one and everybody pays the category price.
     */
    const allowance = await readShowcaseAllowance(tx, {
      providerId: input.providerId,
      directShowcaseProviderId: input.directShowcaseProviderId,
      showcaseLeadId: input.showcaseLeadId,
      roundSource: input.roundSource,
    });
    const claimable = allowance && allowance.remaining > 0 ? allowance : null;

    const unlimited = await this.findUnlimited(tx, input);
    if (unlimited) {
      if (claimable && (await this.dailyLimitReached(tx, unlimited, input.now))) {
        return showcaseDecision(claimable);
      }
      await this.assertDailyLimit(tx, unlimited, input.now);

      return {
        source: OfferEntitlementSource.UNLIMITED,
        entitlementId: unlimited.id,
        creditCost: input.creditCost,
      };
    }

    if (claimable) {
      return showcaseDecision(claimable);
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
    // Promo credit whose lot has passed its expiry but which the sweep has
    // not yet taken out of the wallet still sits inside `balanceBefore`. It
    // cannot pay (CMP-002 S2B1): a late sweeper must never let a dead lot buy
    // an offer. Zero for every provider without such a lot — which, while
    // the campaign engine is off, is every provider.
    const unsweptExpired = await readUnsweptExpiredPromoCredits(tx, input.providerId, input.now);
    if (balanceBefore - unsweptExpired < input.creditCost) {
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
   * What {@link resolve} would choose right now, without spending anything and
   * without refusing: the two refusals become states a form can render.
   *
   * Reads only, in the caller's transaction. The offer itself re-resolves
   * under its own Serializable transaction and compares against the figure
   * this returned (`expectedCreditCost`), so a preview that went stale — the
   * last free slot taken by a concurrent offer — is answered with a 409, never
   * a silent charge.
   */
  async preview(tx: Prisma.TransactionClient, input: ResolveInput): Promise<OfferCostPreview> {
    const allowance = await readShowcaseAllowance(tx, {
      providerId: input.providerId,
      directShowcaseProviderId: input.directShowcaseProviderId,
      showcaseLeadId: input.showcaseLeadId,
      roundSource: input.roundSource,
    });
    const allowanceView = allowance
      ? { quotaTotal: allowance.quotaTotal, quotaUsed: allowance.quotaUsed, remaining: allowance.remaining }
      : null;
    const allowanceVoided = allowance
      ? false
      : await isShowcaseAllowanceVoided(tx, {
          providerId: input.providerId,
          directShowcaseProviderId: input.directShowcaseProviderId,
          showcaseLeadId: input.showcaseLeadId,
          roundSource: input.roundSource,
        });
    const base = { categoryCreditCost: input.creditCost, allowance: allowanceView, allowanceVoided };

    try {
      const decision = await this.resolve(tx, input);
      const kind =
        decision.source === OfferEntitlementSource.SHOWCASE_PLACEMENT
          ? 'SHOWCASE_ALLOWANCE'
          : decision.source === OfferEntitlementSource.UNLIMITED
            ? 'UNLIMITED'
            : decision.source === OfferEntitlementSource.MONTHLY_QUOTA
              ? 'MONTHLY_QUOTA'
              : 'CREDITS';
      return { ...base, kind, creditCost: decision.creditCost };
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.PAYMENT_REQUIRED) {
        return { ...base, kind: 'INSUFFICIENT_CREDITS', creditCost: input.creditCost };
      }
      if (error instanceof ConflictException) {
        return { ...base, kind: 'DAILY_LIMIT', creditCost: input.creditCost };
      }
      throw error;
    }
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
    context: {
      providerId: string;
      offerId: string;
      reason: string;
      now: Date;
      /** What the usage row of a free vitrin offer records. */
      offer?: { requestId: string; matchRoundId: string; categoryId: string; listCreditCost: number };
    },
  ): Promise<{ creditTransactionId: string | null; allowanceUsage?: AllowanceUsageReceipt }> {
    if (decision.source === OfferEntitlementSource.SHOWCASE_PLACEMENT) {
      // One slot of the placement's allowance, claimed by a conditional
      // increment and recorded by an append-only usage row. No ledger row, no
      // balance movement, no promo lot: the usage row is the whole record, and
      // its `listCreditCostSnapshot` is the subsidy finance reads.
      if (!context.offer) {
        throw new Error('A free vitrin offer needs its request, round and category to be recorded');
      }
      const ordinal = await claimAllowanceSlot(tx, decision.allowance.grantId);
      if (ordinal === null) {
        throw new ShowcaseAllowanceUnavailable();
      }
      await recordAllowanceUsage(tx, {
        grantId: decision.allowance.grantId,
        ordinal,
        offerId: context.offerId,
        providerId: context.providerId,
        requestId: context.offer.requestId,
        matchRoundId: context.offer.matchRoundId,
        showcaseLeadId: decision.allowance.showcaseLeadId,
        categoryId: context.offer.categoryId,
        listCreditCost: context.offer.listCreditCost,
        now: context.now,
      });
      return {
        creditTransactionId: null,
        allowanceUsage: {
          grantId: decision.allowance.grantId,
          placementId: decision.allowance.placementId,
          ordinal,
          quotaTotal: decision.allowance.quotaTotal,
        },
      };
    }

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

    // One ledger row for the whole cost, and the promo shares that paid it,
    // through the canonical waterfall (CAMPAIGN-CREDIT-POLICY-001):
    // PROMO_FIRST lots, then paid credit, then PAID_FIRST lots — per lot,
    // by the policy of the version each lot was granted under. `resolve`
    // already judged affordability in this transaction; a refusal here can
    // only mean the wallet moved, and it answers the same 402.
    let transaction;
    try {
      ({ transaction } = await debitWallet(tx, {
        providerId: context.providerId,
        amount: decision.creditCost,
        purpose: PromoConsumptionSource.OFFER_SPEND,
        now: context.now,
        ledger: { reason: context.reason, referenceType: 'Offer', referenceId: context.offerId, createdById: null },
      }));
    } catch (error) {
      if (error instanceof WalletDebitRefused) {
        throw new HttpException(INSUFFICIENT_CREDIT_MESSAGE, HttpStatus.PAYMENT_REQUIRED);
      }
      throw error;
    }

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
  private async dailyLimitReached(
    tx: Prisma.TransactionClient,
    entitlement: { id: string; dailyOfferLimitSnapshot: number | null },
    now: Date,
  ): Promise<boolean> {
    if (entitlement.dailyOfferLimitSnapshot === null) {
      return false;
    }

    const usedToday = await tx.offer.count({
      where: {
        entitlementId: entitlement.id,
        submittedAt: { gte: istanbulDayStart(now) },
      },
    });

    return usedToday >= entitlement.dailyOfferLimitSnapshot;
  }

  private async assertDailyLimit(
    tx: Prisma.TransactionClient,
    entitlement: { id: string; dailyOfferLimitSnapshot: number | null },
    now: Date,
  ) {
    if (await this.dailyLimitReached(tx, entitlement, now)) {
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

function showcaseDecision(allowance: ShowcaseAllowanceState): EntitlementDecision {
  return {
    source: OfferEntitlementSource.SHOWCASE_PLACEMENT,
    entitlementId: null,
    creditCost: 0,
    allowance,
  };
}
