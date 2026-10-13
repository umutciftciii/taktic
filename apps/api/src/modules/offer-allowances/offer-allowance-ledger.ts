import {
  MatchRoundSource,
  OfferAllowanceBenefit,
  OfferAllowanceSource,
  OfferAllowanceStatus,
  Prisma,
} from '@prisma/client';

/**
 * CAMPAIGN-ENTITLEMENT-001 — bounded vitrin offer allowances.
 *
 * Every vitrin placement carries one grant of {@link SHOWCASE_FREE_OFFER_QUOTA}
 * free offers, spendable only on the direct leads that arrived through that
 * very placement. The placement is the scope: a renewal is a new placement and
 * a new grant; nothing transfers, nothing rolls over, and nothing is given back
 * once spent.
 *
 * Everything here runs inside the caller's transaction — the placement's birth
 * for {@link grantShowcasePlacementAllowance}, the offer's own Serializable
 * create for the rest — and nothing here is a service with state, in the same
 * shape as the wallet primitives in `credits/promo-credit-ledger.ts`.
 */

/**
 * How many free offers one vitrin placement carries. Snapshotted onto the grant
 * as `quotaTotal`, so changing this number governs the next placement and never
 * one already on the air. There is deliberately no package-level setting in v1.
 */
export const SHOWCASE_FREE_OFFER_QUOTA = 3;

/**
 * Opens the grant a newly born placement carries, in the transaction that
 * births it.
 *
 * Idempotent on the database's own guard: `showcasePlacementId` is unique and
 * the insert is `ON CONFLICT DO NOTHING`, so a replayed birth cannot produce a
 * second grant — and, unlike a caught P2002, it never aborts the caller's
 * transaction.
 */
export async function grantShowcasePlacementAllowance(
  tx: Prisma.TransactionClient,
  input: { placementId: string; providerId: string; startAt: Date },
): Promise<{ grantId: string; quotaTotal: number }> {
  await tx.offerAllowanceGrant.createMany({
    data: [
      {
        providerId: input.providerId,
        source: OfferAllowanceSource.SHOWCASE_PLACEMENT,
        benefit: OfferAllowanceBenefit.FREE_OFFER,
        showcasePlacementId: input.placementId,
        quotaTotal: SHOWCASE_FREE_OFFER_QUOTA,
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
