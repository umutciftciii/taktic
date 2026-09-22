import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  OfferPackageType,
  PackagePurchaseKind,
  PackagePurchaseStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  evaluatePackageRefundEligibility,
  type PackageRefundEligibility,
  type PackageRefundEligibilityFacts,
} from './package-refund-eligibility';

type FactsRow = {
  id: string;
  kind: PackagePurchaseKind;
  status: PackagePurchaseStatus;
  packageType: OfferPackageType | null;
  paidAt: Date | null;
  manualReviewAt: Date | null;
  offerSpendCount: number;
  firstOfferSpendAt: Date | null;
  linkedPromoConsumptionCount: number;
  linkedPromoConsumedCredits: number;
};

/**
 * Reads the facts {@link evaluatePackageRefundEligibility} needs and hands
 * them to it. Read-only: this service writes nothing, calls no payment
 * provider and changes no balance (CMP-006 PR-A — advice only).
 *
 * **One statement, one snapshot.** Every fact comes out of a single SELECT, so
 * PostgreSQL evaluates all of them against the same snapshot even at READ
 * COMMITTED: a spend or a promo consumption committing concurrently is either
 * wholly visible or wholly invisible to one evaluation, never half. Two
 * evaluations at the same `now` over unchanged data are identical, and the
 * pure function orders its reasons canonically — so concurrent and repeated
 * reads cannot disagree.
 *
 * `now` is a parameter for the same reason: the clock is an input, not
 * something read halfway through.
 */
@Injectable()
export class PackageRefundEligibilityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async evaluate(purchaseId: string, now: Date = new Date()): Promise<PackageRefundEligibility> {
    const facts = await this.readFacts(this.prisma, purchaseId);
    if (!facts) {
      throw new NotFoundException('Package purchase not found');
    }
    return evaluatePackageRefundEligibility(facts, now);
  }

  /** Exported for callers that already hold a transaction (PR-B). */
  async readFacts(
    client: Pick<Prisma.TransactionClient, '$queryRaw'>,
    purchaseId: string,
  ): Promise<PackageRefundEligibilityFacts | null> {
    const rows = await client.$queryRaw<FactsRow[]>(Prisma.sql`
      SELECT
        p."id",
        p."kind",
        p."status",
        op."type" AS "packageType",
        p."paidAt",
        p."manualReviewAt",
        (
          SELECT count(*)::int FROM "ProviderCreditTransaction" t
          WHERE t."providerId" = p."providerId"
            AND t."type" = 'OFFER_SPEND'
            AND p."paidAt" IS NOT NULL
            AND t."createdAt" >= p."paidAt"
        ) AS "offerSpendCount",
        (
          SELECT min(t."createdAt") FROM "ProviderCreditTransaction" t
          WHERE t."providerId" = p."providerId"
            AND t."type" = 'OFFER_SPEND'
            AND p."paidAt" IS NOT NULL
            AND t."createdAt" >= p."paidAt"
        ) AS "firstOfferSpendAt",
        (
          SELECT count(*)::int FROM "PromoCreditLotConsumption" c
          JOIN "PromoCreditLot" l ON l."id" = c."lotId"
          JOIN "CampaignRedemption" r ON r."id" = l."redemptionId"
          WHERE r."purchaseId" = p."id"
        ) AS "linkedPromoConsumptionCount",
        (
          SELECT coalesce(sum(c."consumedCredits"), 0)::int FROM "PromoCreditLotConsumption" c
          JOIN "PromoCreditLot" l ON l."id" = c."lotId"
          JOIN "CampaignRedemption" r ON r."id" = l."redemptionId"
          WHERE r."purchaseId" = p."id"
        ) AS "linkedPromoConsumedCredits"
      FROM "PackagePurchase" p
      LEFT JOIN "OfferCreditPackage" op ON op."id" = p."packageId"
      WHERE p."id" = ${purchaseId}
    `);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      purchaseId: row.id,
      kind: row.kind,
      status: row.status,
      packageType: row.packageType,
      paidAt: row.paidAt,
      reversalRecordedAt: row.manualReviewAt,
      offerSpendCountSincePaid: row.offerSpendCount,
      firstOfferSpendAtSincePaid: row.firstOfferSpendAt,
      linkedPromoConsumptionCount: row.linkedPromoConsumptionCount,
      linkedPromoConsumedCredits: row.linkedPromoConsumedCredits,
    };
  }
}
