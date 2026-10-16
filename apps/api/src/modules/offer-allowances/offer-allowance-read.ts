import { Prisma } from '@prisma/client';

/**
 * CAMPAIGN-ENTITLEMENT-001 — the operator's reading of an allowance.
 *
 * A grant's counts and subsidy are the placement's own facts and travel with
 * the placement (SHOWCASE_PLACEMENTS_READ). Which offers spent the slots is
 * the offers domain's, and travels only with OFFERS_READ
 * (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001): without it the `usages` key is
 * absent, never an empty list.
 */
export const adminAllowanceGrantSelect = {
  select: {
    id: true,
    quotaTotal: true,
    quotaUsed: true,
    status: true,
    validFrom: true,
    grantedAt: true,
    voidedAt: true,
    voidReason: true,
    voidNote: true,
    voidedBy: { select: { id: true, name: true } },
    usages: {
      orderBy: { ordinal: 'asc' },
      select: {
        ordinal: true,
        offerId: true,
        requestId: true,
        listCreditCostSnapshot: true,
        consumedAt: true,
        offer: { select: { offerNumber: true, status: true } },
      },
    },
  },
} satisfies { select: Prisma.OfferAllowanceGrantSelect };

type AdminGrantRow = Prisma.OfferAllowanceGrantGetPayload<typeof adminAllowanceGrantSelect>;

export function toAdminOfferAllowance(
  grant: AdminGrantRow | null,
  options: {
    offers: boolean;
    /**
     * SHOWCASE-ALLOWANCE-004 — the run's leads still waiting for their owner's
     * free answer ({@link import('./offer-allowance-ledger').countLeadsAwaitingFreeAnswer}),
     * which the void dialog shows and posts back as an expectation.
     */
    openLeads: number;
  },
) {
  if (!grant) {
    // A run that ended before allowances existed and was not live at rollout.
    return null;
  }

  return {
    id: grant.id,
    status: grant.status,
    quotaTotal: grant.quotaTotal,
    quotaUsed: grant.quotaUsed,
    remaining: grant.quotaTotal - grant.quotaUsed,
    /**
     * Slots counted at rollout for answers given under the old unlimited rule
     * (quotaUsed without a usage row). Zero for every run born after it.
     */
    legacyFreeOffers: grant.quotaUsed - grant.usages.length,
    /** The category credits the free answers would have cost — the subsidy. */
    subsidyCredits: grant.usages.reduce((sum, usage) => sum + usage.listCreditCostSnapshot, 0),
    validFrom: grant.validFrom,
    grantedAt: grant.grantedAt,
    openLeads: options.openLeads,
    /**
     * SHOWCASE-ALLOWANCE-004 — the void, as recorded: when, the reason code,
     * the internal note and the super admin who did it. All null on an ACTIVE
     * grant. Staff-only: no provider projection carries any of the four.
     */
    voidedAt: grant.voidedAt,
    voidReason: grant.voidReason,
    voidNote: grant.voidNote,
    voidedBy: grant.voidedBy,
    /** The slots the void took away: what was left when it was written (frozen since). */
    voidedRemaining: grant.status === 'VOID' ? grant.quotaTotal - grant.quotaUsed : 0,
    ...(options.offers
      ? {
          usages: grant.usages.map((usage) => ({
            ordinal: usage.ordinal,
            offerId: usage.offerId,
            offerNumber: usage.offer.offerNumber,
            offerStatus: usage.offer.status,
            requestId: usage.requestId,
            listCreditCostSnapshot: usage.listCreditCostSnapshot,
            consumedAt: usage.consumedAt,
          })),
        }
      : {}),
  };
}
