import {
  MatchRoundSource,
  OfferAllowanceBenefit,
  OfferAllowanceSource,
  OfferAllowanceStatus,
  Prisma,
  ServiceRequestStatus,
  ShowcaseLeadStatus,
} from '@prisma/client';

/**
 * CAMPAIGN-ENTITLEMENT-001 — bounded vitrin offer allowances.
 *
 * Every vitrin placement carries one grant of free offers, spendable only on
 * the direct leads that arrived through that very placement. The placement is
 * the scope: a renewal is a new placement and a new grant; nothing transfers,
 * nothing rolls over, and nothing is given back once spent.
 *
 * SHOWCASE-ALLOWANCE-001 — how many free offers a grant carries is the
 * package's `freeOfferCount`, snapshotted along the sale (purchase → right /
 * placement → grant), never re-read from the catalogue.
 *
 * Everything here runs inside the caller's transaction — the placement's birth
 * for {@link grantShowcasePlacementAllowance}, the offer's own Serializable
 * create for the rest — and nothing here is a service with state, in the same
 * shape as the wallet primitives in `credits/promo-credit-ledger.ts`.
 */

/**
 * The free offers every run carried before the count became a package setting
 * (CAMPAIGN-ENTITLEMENT-001), and therefore what a sale recorded without a
 * snapshot was sold with: the default of `ShowcasePackage.freeOfferCount` and
 * of the entitlement / placement snapshots, and the reading of a vitrin
 * purchase whose checkout an older application version opened.
 */
export const LEGACY_SHOWCASE_FREE_OFFER_COUNT = 3;

/**
 * The free offers a vitrin purchase was sold with: its snapshot, or the legacy
 * figure for a checkout opened before the snapshot existed. Never the package's
 * current value — that may have been edited since the buyer saw it.
 */
export function purchaseFreeOfferCount(purchase: {
  freeOfferCountSnapshot: number | null;
}): number {
  return purchase.freeOfferCountSnapshot ?? LEGACY_SHOWCASE_FREE_OFFER_COUNT;
}

/**
 * Opens the grant a newly born placement carries, in the transaction that
 * births it, with the placement's own `freeOfferCountSnapshot` as its quota.
 *
 * Idempotent on the database's own guard: `showcasePlacementId` is unique and
 * the insert is `ON CONFLICT DO NOTHING`, so a replayed birth cannot produce a
 * second grant — and, unlike a caught P2002, it never aborts the caller's
 * transaction. The returned quota is the stored grant's, so a replay reports
 * what was actually granted.
 */
export async function grantShowcasePlacementAllowance(
  tx: Prisma.TransactionClient,
  input: { placementId: string; providerId: string; startAt: Date; quotaTotal: number },
): Promise<{ grantId: string; quotaTotal: number }> {
  if (!Number.isInteger(input.quotaTotal) || input.quotaTotal < 1) {
    // The CHECK would refuse it too; failing here names the cause.
    throw new Error(`Invalid showcase allowance quota ${input.quotaTotal} for placement ${input.placementId}`);
  }

  await tx.offerAllowanceGrant.createMany({
    data: [
      {
        providerId: input.providerId,
        source: OfferAllowanceSource.SHOWCASE_PLACEMENT,
        benefit: OfferAllowanceBenefit.FREE_OFFER,
        showcasePlacementId: input.placementId,
        quotaTotal: input.quotaTotal,
        quotaUsed: 0,
        validFrom: input.startAt,
      },
    ],
    skipDuplicates: true,
  });

  const grant = await tx.offerAllowanceGrant.findUniqueOrThrow({
    where: { showcasePlacementId: input.placementId },
    select: { id: true, quotaTotal: true },
  });

  return { grantId: grant.id, quotaTotal: grant.quotaTotal };
}

/** What the offer path knows about the request, read in its own transaction. */
export type ShowcaseAllowanceRequestFacts = {
  providerId: string;
  /** `ServiceRequest.directShowcaseProviderId` — the gate. */
  directShowcaseProviderId: string | null | undefined;
  /** `ServiceRequest.showcaseLeadId`. */
  showcaseLeadId: string | null | undefined;
  /** The current round's source. Only a DIRECT_SHOWCASE round can use an allowance. */
  roundSource: MatchRoundSource | null | undefined;
};

/** The allowance a direct lead is bound to, whether or not a slot is left. */
export type ShowcaseAllowanceState = {
  grantId: string;
  placementId: string;
  showcaseLeadId: string;
  quotaTotal: number;
  quotaUsed: number;
  remaining: number;
};

/**
 * The grant this request's answer may be paid from, read whole — or null when
 * the request is not this provider's own gated direct lead, or its placement
 * has no ACTIVE grant.
 *
 * The binding is the lead, never "any placement this provider has": the lead
 * names the placement it arrived through, and only that placement's grant can
 * pay for answering it. Every clause is required — the gate names this
 * provider, the round is still the DIRECT_SHOWCASE one (REL-002 R2+ and a
 * released lead are MARKETPLACE), the lead is addressed to this provider and
 * the grant is this provider's.
 *
 * There is no clock here on purpose. A lead can only be opened while its
 * placement is live, so "leads received during the run" is already the scope;
 * a lead received on the run's last day keeps its allowance until it is
 * resolved, however long after `endAt` that is.
 */
export async function readShowcaseAllowance(
  tx: Prisma.TransactionClient,
  facts: ShowcaseAllowanceRequestFacts,
): Promise<ShowcaseAllowanceState | null> {
  if (
    !facts.directShowcaseProviderId ||
    facts.directShowcaseProviderId !== facts.providerId ||
    !facts.showcaseLeadId ||
    facts.roundSource !== MatchRoundSource.DIRECT_SHOWCASE
  ) {
    return null;
  }

  const lead = await tx.showcaseLead.findUnique({
    where: { id: facts.showcaseLeadId },
    select: { id: true, providerId: true, placementId: true },
  });
  if (!lead || lead.providerId !== facts.providerId) {
    return null;
  }

  const grant = await tx.offerAllowanceGrant.findUnique({
    where: { showcasePlacementId: lead.placementId },
    select: { id: true, providerId: true, status: true, quotaTotal: true, quotaUsed: true },
  });
  if (
    !grant ||
    grant.providerId !== facts.providerId ||
    grant.status !== OfferAllowanceStatus.ACTIVE
  ) {
    return null;
  }

  return {
    grantId: grant.id,
    placementId: lead.placementId,
    showcaseLeadId: lead.id,
    quotaTotal: grant.quotaTotal,
    quotaUsed: grant.quotaUsed,
    remaining: grant.quotaTotal - grant.quotaUsed,
  };
}

/**
 * SHOWCASE-ALLOWANCE-004 — whether this request's answer *would* have been
 * bound to a grant that a super admin has since voided.
 *
 * The same binding as {@link readShowcaseAllowance}, clause for clause, read
 * only to choose the words: a VOID grant pays for nothing either way, and the
 * resolver never sees it. What changes is what the provider is told — "the
 * free offers were cancelled", not "the free offers ran out".
 */
export async function isShowcaseAllowanceVoided(
  tx: Prisma.TransactionClient,
  facts: ShowcaseAllowanceRequestFacts,
): Promise<boolean> {
  if (
    !facts.directShowcaseProviderId ||
    facts.directShowcaseProviderId !== facts.providerId ||
    !facts.showcaseLeadId ||
    facts.roundSource !== MatchRoundSource.DIRECT_SHOWCASE
  ) {
    return false;
  }

  const lead = await tx.showcaseLead.findUnique({
    where: { id: facts.showcaseLeadId },
    select: { providerId: true, placementId: true },
  });
  if (!lead || lead.providerId !== facts.providerId) {
    return false;
  }

  const grant = await tx.offerAllowanceGrant.findUnique({
    where: { showcasePlacementId: lead.placementId },
    select: { providerId: true, status: true },
  });
  return grant?.providerId === facts.providerId && grant.status === OfferAllowanceStatus.VOID;
}

/**
 * SHOWCASE-ALLOWANCE-004 — the placement's leads still waiting for their
 * owner's free answer: the spend path's own binding (lead OPEN / BREACHED,
 * request gated to the owner and SUBMITTED / APPROVED, current round
 * DIRECT_SHOWCASE), counted. The finance report's `openLeads` is the same
 * predicate in SQL.
 *
 * A model query, not raw SQL: it runs inside the void's Serializable
 * transaction, where a raw query's serialization failure (P2010) would not be
 * retried by `runSerializable`.
 */
export function countLeadsAwaitingFreeAnswer(
  tx: Prisma.TransactionClient,
  input: { placementId: string; providerId: string },
): Promise<number> {
  return tx.showcaseLead.count({
    where: {
      placementId: input.placementId,
      providerId: input.providerId,
      status: { in: [ShowcaseLeadStatus.OPEN, ShowcaseLeadStatus.BREACHED] },
      requestGate: {
        is: {
          directShowcaseProviderId: input.providerId,
          status: { in: [ServiceRequestStatus.SUBMITTED, ServiceRequestStatus.APPROVED] },
          currentRound: { source: MatchRoundSource.DIRECT_SHOWCASE },
        },
      },
    },
  });
}

/**
 * Claims the next slot of a grant, atomically: one conditional UPDATE whose
 * WHERE carries `quotaUsed < quotaTotal`, returning the slot number it took.
 *
 * Two offers racing for a grant's last slot both reach this row; Postgres lets
 * one update it and, under the caller's Serializable transaction, fails the
 * other with a serialization error that `runSerializable` replays — and the
 * replay reads the grant exhausted. `null` (no row matched) is the same fact
 * reached without a conflict, and the caller must not treat it as free.
 */
export async function claimAllowanceSlot(
  tx: Prisma.TransactionClient,
  grantId: string,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ quotaUsed: number }[]>`
    UPDATE "OfferAllowanceGrant"
       SET "quotaUsed" = "quotaUsed" + 1,
           "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
     WHERE "id" = ${grantId}
       AND "status" = 'ACTIVE'
       AND "quotaUsed" < "quotaTotal"
    RETURNING "quotaUsed"`;

  const [row] = rows;
  return rows.length === 1 && row ? Number(row.quotaUsed) : null;
}

/** The append-only record that one slot paid for one offer. */
export async function recordAllowanceUsage(
  tx: Prisma.TransactionClient,
  input: {
    grantId: string;
    ordinal: number;
    offerId: string;
    providerId: string;
    requestId: string;
    matchRoundId: string;
    showcaseLeadId: string;
    categoryId: string;
    listCreditCost: number;
    now: Date;
  },
): Promise<{ usageId: string }> {
  const usage = await tx.offerAllowanceUsage.create({
    data: {
      grantId: input.grantId,
      ordinal: input.ordinal,
      offerId: input.offerId,
      providerId: input.providerId,
      requestId: input.requestId,
      matchRoundId: input.matchRoundId,
      showcaseLeadId: input.showcaseLeadId,
      categoryId: input.categoryId,
      listCreditCostSnapshot: input.listCreditCost,
      consumedAt: input.now,
    },
    select: { id: true },
  });

  return { usageId: usage.id };
}
