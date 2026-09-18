import { Prisma, ProviderStatus } from '@prisma/client';

/**
 * The one definition of "this placement is on the air".
 *
 * Every public vitrin read — the shelf, one card's page, and the sitemap that
 * lists the cards — must answer the same question with the same six clauses,
 * or a card could appear in one place and 404 in another. So the predicate is
 * written once, as a SQL fragment over the aliases those queries all use:
 *
 *   p   ShowcasePlacement       the paid run: ACTIVE and inside its window
 *   c   ShowcaseCard            the card: APPROVED
 *   v   ShowcaseCardVersion     the pinned version: its review APPROVED
 *   pr  ProviderProfile         the business: APPROVED, the one public status
 *
 * A suspended run, a run that has ended or not started, a card an operator
 * pulled, a version awaiting review and a business that is no longer approved
 * all fail here, and fail identically everywhere.
 */
export function livePlacementPredicate(now: Date): Prisma.Sql {
  return Prisma.sql`
        p."status" = 'ACTIVE'
        AND p."startAt" <= ${now}
        AND p."endAt"   >  ${now}
        AND c."status" = 'APPROVED'
        AND v."reviewStatus" = 'APPROVED'
        AND pr."status" = ${Prisma.raw(`'${ProviderStatus.APPROVED}'`)}::"ProviderStatus"`;
}
