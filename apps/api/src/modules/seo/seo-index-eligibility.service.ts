import { Inject, Injectable } from '@nestjs/common';
import { Prisma, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLICLY_VISIBLE_PROVIDER_STATUSES } from '../providers/provider-visibility';
import { livePlacementPredicate } from '../showcase/showcase-live-placement';
import {
  categoryIndexFacts,
  evaluateCategoryIndexability,
  evaluateProviderIndexability,
  evaluateShowcaseCardIndexability,
  evaluateShowcaseShelfIndexability,
  isCategoryIndexable,
  isProviderIndexable,
  isShowcaseShelfIndexable,
  markDuplicateSummaries,
  type SeoIndexEvaluation,
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
  title: string;
  providerName: string;
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

export type LiveCardEvaluation = {
  cardId: string;
  title: string;
  providerId: string;
  providerName: string;
  evaluation: SeoIndexEvaluation;
};

/** The columns the category rule reads, and the labels the admin list shows. */
const categoryFactsSelect = {
  id: true,
  name: true,
  slug: true,
  kind: true,
  status: true,
  description: true,
  editorialDecisionGuide: true,
  editorialPriceFactors: true,
  editorialFaq: true,
  updatedAt: true,
} satisfies Prisma.ServiceCategorySelect;

const providerFactsSelect = {
  id: true,
  businessName: true,
  updatedAt: true,
  status: true,
  description: true,
  city: true,
  district: true,
  serviceCategories: { select: { category: { select: { status: true, kind: true } } } },
  serviceAreas: { select: { scope: true, city: true, district: true, neighborhood: true } },
} satisfies Prisma.ProviderProfileSelect;

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
    const evaluations = await this.liveShowcaseCardEvaluations(now, scope);
    return new Map([...evaluations].map(([cardId, card]) => [cardId, card.evaluation.indexable]));
  }

  /**
   * SEO-004: the same answer with its reasons, and the two labels an
   * operator needs to recognise the card (its title, its business). Read by
   * the admin API only; the public readers take the boolean above.
   */
  async liveShowcaseCardEvaluations(
    now: Date,
    scope: { ofCard?: string } = {},
  ): Promise<Map<string, LiveCardEvaluation>> {
    const providerFilter = scope.ofCard
      ? Prisma.sql`AND pr."id" = (SELECT sc."providerId" FROM "ShowcaseCard" sc WHERE sc."id" = ${scope.ofCard})`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<LiveCardFactsRow[]>(Prisma.sql`
      SELECT DISTINCT ON (c."id")
        c."id"            AS "cardId",
        pr."id"           AS "providerId",
        v."title"         AS "title",
        pr."businessName" AS "providerName",
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
        {
          cardId: row.cardId,
          title: row.title,
          providerId: row.providerId,
          providerName: row.providerName,
          evaluation: evaluateShowcaseCardIndexability({
            live: true,
            providerIndexable: providerIndexable.get(row.providerId) ?? false,
            summary: row.summary,
            scopeIncluded: row.scopeIncluded,
            scopeExcluded: row.scopeExcluded,
            summaryDuplicated: row.summaryDuplicated,
          }),
        },
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
    const providers = await this.publicProviderRows();
    return providers
      .filter((provider) => isProviderIndexable(provider))
      .map((provider) => ({ id: provider.id, updatedAt: provider.updatedAt }));
  }

  /**
   * SEO-004: every publicly visible business with its evaluation, for the
   * admin API. The name is the one the public profile already prints.
   */
  async providerEvaluations(): Promise<
    Array<{ id: string; name: string; updatedAt: Date; evaluation: SeoIndexEvaluation }>
  > {
    const providers = await this.publicProviderRows();
    return providers.map((provider) => ({
      id: provider.id,
      name: provider.businessName,
      updatedAt: provider.updatedAt,
      evaluation: evaluateProviderIndexability(provider),
    }));
  }

  private publicProviderRows() {
    return this.prisma.providerProfile.findMany({
      where: { status: { in: [...PUBLICLY_VISIBLE_PROVIDER_STATUSES] } },
      select: providerFactsSelect,
      orderBy: { id: 'asc' },
    });
  }

  /**
   * The categories the sitemap lists: the public catalogue's ACTIVE leaves
   * (as `GET /categories` serves them) that pass the category rule, read with
   * the editorial blocks (SEO-004) the public listing does not carry.
   */
  async listIndexableCategories(): Promise<Array<{ slug: string; updatedAt: Date }>> {
    const categories = await this.prisma.serviceCategory.findMany({
      where: { status: ServiceCategoryStatus.ACTIVE, kind: ServiceCategoryKind.LEAF },
      select: categoryFactsSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories
      .filter((category) => isCategoryIndexable(categoryIndexFacts(category)))
      .map((category) => ({ slug: category.slug, updatedAt: category.updatedAt }));
  }

  /**
   * SEO-004: every category with a public page — an ACTIVE leaf or router,
   * `isPubliclyReachable` — with its evaluation. A router's page is public and
   * never indexable (the rule wants a leaf), and says so.
   */
  async categoryEvaluations(): Promise<
    Array<{ id: string; name: string; slug: string; kind: ServiceCategoryKind; updatedAt: Date; evaluation: SeoIndexEvaluation }>
  > {
    const categories = await this.prisma.serviceCategory.findMany({
      where: {
        status: ServiceCategoryStatus.ACTIVE,
        kind: { in: [ServiceCategoryKind.LEAF, ServiceCategoryKind.ROUTER] },
      },
      select: categoryFactsSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      kind: category.kind,
      updatedAt: category.updatedAt,
      evaluation: evaluateCategoryIndexability(categoryIndexFacts(category)),
    }));
  }

  /** SEO-004: the shelf's evaluation, from the same live-card answers the feed uses. */
  async shelfEvaluation(now: Date): Promise<SeoIndexEvaluation> {
    const ids = await this.listIndexableLiveShowcaseCardIds(now);
    return evaluateShowcaseShelfIndexability(ids.length);
  }
}
