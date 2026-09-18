import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLICLY_VISIBLE_PROVIDER_STATUSES } from '../providers/provider-visibility';
import { livePlacementPredicate } from '../showcase/showcase-live-placement';
import {
  isProviderIndexable,
  isShowcaseCardIndexable,
  isShowcaseShelfIndexable,
  markDuplicateSummaries,
} from './seo-index-eligibility';

/**
 * The rows the pure rules need, loaded the way the three readers can share:
 * one query per question, never one per record.
 *
 *   sitemap          every indexable business; every indexable live card
 *   feed             how many live cards are indexable (the shelf's rule)
 *   one card's page  whether that card is indexable — which needs the
 *                    business's other live cards, for the copied-summary rule
 *
 * The card query is the shelf's own "on the air" join (`livePlacementPredicate`
 * and the active-shelf EXISTS, exactly as the feed and the sitemap write them)
 * with the business's facts aggregated beside each card, so a card the feed
 * serves is a card this vouches for or refuses, and no other.
 *
 * Nothing here is a public shape. Descriptions, statuses and area rows are
 * read to answer a boolean and go no further; the callers put the boolean on
 * their projection and nothing else.
 */

type LiveCardFactsRow = {
  cardId: string;
  providerId: string;
  summary: string | null;
  scopeIncluded: unknown;
  scopeExcluded: unknown;
  providerStatus: string;
  providerDescription: string | null;
  providerCity: string;
  providerDistrict: string;
  providerAreas: unknown;
  providerBindings: unknown;
};

@Injectable()
export class SeoIndexEligibilityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every live card, or only the live cards of the business behind `cardId`,
   * each answered true or false. A card that is not on the air is absent —
   * and absent reads as false (see `isShowcaseCardIndexable` below).
   */
  async liveShowcaseCardEligibility(
    now: Date,
    scope: { ofCard?: string } = {},
  ): Promise<Map<string, boolean>> {
    const providerFilter = scope.ofCard
      ? Prisma.sql`AND pr."id" = (SELECT sc."providerId" FROM "ShowcaseCard" sc WHERE sc."id" = ${scope.ofCard})`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<LiveCardFactsRow[]>(Prisma.sql`
      SELECT DISTINCT ON (c."id")
        c."id"            AS "cardId",
        pr."id"           AS "providerId",
        v."summary"       AS "summary",
        v."scopeIncluded" AS "scopeIncluded",
        v."scopeExcluded" AS "scopeExcluded",
        pr."status"::text AS "providerStatus",
        pr."description"  AS "providerDescription",
        pr."city"         AS "providerCity",
        pr."district"     AS "providerDistrict",
        (
          SELECT json_agg(json_build_object(
            'scope', sa."scope", 'city', sa."city", 'district', sa."district", 'neighborhood', sa."neighborhood"
          ))
          FROM "ProviderServiceArea" sa
          WHERE sa."providerId" = pr."id"
        ) AS "providerAreas",
        (
          SELECT json_agg(json_build_object('category', json_build_object('status', cat."status", 'kind', cat."kind")))
          FROM "ProviderServiceCategory" psc
          JOIN "ServiceCategory" cat ON cat."id" = psc."categoryId"
          WHERE psc."providerId" = pr."id"
        ) AS "providerBindings"
      FROM "ShowcasePlacement"   p
      JOIN "ShowcaseCard"        c  ON c."id"  = p."cardId"
      JOIN "ShowcaseCardVersion" v  ON v."id"  = p."pinnedVersionId"
      JOIN "ProviderProfile"     pr ON pr."id" = p."providerId"
      WHERE EXISTS (
              SELECT 1 FROM "ShowcasePlacementShelf" s
              WHERE s."placementId" = p."id" AND s."active"
            )
        AND ${livePlacementPredicate(now)}
        ${providerFilter}
      ORDER BY c."id" ASC
    `);

    const marked = markDuplicateSummaries(rows);
    const providerIndexable = new Map<string, boolean>();
    for (const row of rows) {
      if (!providerIndexable.has(row.providerId)) {
        providerIndexable.set(
          row.providerId,
          isProviderIndexable({
            status: row.providerStatus,
            description: row.providerDescription,
            city: row.providerCity,
            district: row.providerDistrict,
            serviceCategories: row.providerBindings ?? [],
            serviceAreas: row.providerAreas ?? [],
          }),
        );
      }
    }

    return new Map(
      marked.map((row) => [
        row.cardId,
        isShowcaseCardIndexable({
          live: true,
          providerIndexable: providerIndexable.get(row.providerId) ?? false,
          summary: row.summary,
          scopeIncluded: row.scopeIncluded,
          scopeExcluded: row.scopeExcluded,
          summaryDuplicated: row.summaryDuplicated,
        }),
      ]),
    );
  }

  /** The ids the sitemap lists, ascending. */
  async listIndexableLiveShowcaseCardIds(now: Date): Promise<string[]> {
    const eligibility = await this.liveShowcaseCardEligibility(now);
    return [...eligibility.entries()].filter(([, indexable]) => indexable).map(([cardId]) => cardId);
  }

  /** The shelf's own answer: enough indexable live cards to be a list. */
  async isShowcaseShelfIndexable(now: Date): Promise<boolean> {
    const ids = await this.listIndexableLiveShowcaseCardIds(now);
    return isShowcaseShelfIndexable(ids.length);
  }

  /** One card's answer — false for a card that is not on the air at all. */
  async isShowcaseCardIndexable(cardId: string, now: Date): Promise<boolean> {
    const eligibility = await this.liveShowcaseCardEligibility(now, { ofCard: cardId });
    return eligibility.get(cardId) ?? false;
  }

  /**
   * The businesses the sitemap lists: publicly visible *and* indexable. One
   * query with the bindings and areas the rule reads; the descriptions do not
   * leave this method.
   */
  async listIndexableProviders(): Promise<Array<{ id: string; updatedAt: Date }>> {
    const providers = await this.prisma.providerProfile.findMany({
      where: { status: { in: [...PUBLICLY_VISIBLE_PROVIDER_STATUSES] } },
      select: {
        id: true,
        updatedAt: true,
        status: true,
        description: true,
        city: true,
        district: true,
        serviceCategories: { select: { category: { select: { status: true, kind: true } } } },
        serviceAreas: { select: { scope: true, city: true, district: true, neighborhood: true } },
      },
      orderBy: { id: 'asc' },
    });

    return providers
      .filter((provider) => isProviderIndexable(provider))
      .map((provider) => ({ id: provider.id, updatedAt: provider.updatedAt }));
  }
}
