import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CategoriesService } from '../categories/categories.service';
import { PUBLICLY_VISIBLE_PROVIDER_STATUSES } from '../providers/provider-visibility';
import { livePlacementPredicate } from '../showcase/showcase-live-placement';

/**
 * What the web's `sitemap.xml` is built from: the identifiers of every record
 * that has a public page right now, and nothing about the record itself.
 *
 * ## Three visibility rules, none of them new
 *
 *   categories     the public catalogue as `GET /categories` serves it —
 *                  ACTIVE leaves — read through the same service method, so
 *                  there is one definition of "listed"
 *   providers      the one status the public profile renders
 *                  (provider-visibility.ts), as a `where` over the same list
 *   showcaseCards  the shelf's own "on the air" predicate
 *                  (showcase-live-placement.ts), shared with the feed and the
 *                  card page, so a listed card is a card those serve
 *
 * ## Deliberately not a directory
 *
 * A slug, an id and the row's `updatedAt` — the two things a sitemap row is
 * made of — and no third field. Not the business name, not its city, not a
 * card's title or price: those are on the page behind the id, under that
 * page's public projection, and a second copy here would be a second place to
 * keep private. Three queries, no per-row work, whatever the counts.
 */
@Injectable()
export class SitemapService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
  ) {}

  async listEntries() {
    const [categories, providers, showcaseCards] = await Promise.all([
      this.listCategories(),
      this.listProviders(),
      this.listLiveShowcaseCards(new Date()),
    ]);

    return { categories, providers, showcaseCards };
  }

  private async listCategories() {
    const listed = await this.categories.listCategories({ isSuperAdmin: false });
    return listed.map((category) => ({ slug: category.slug, updatedAt: category.updatedAt }));
  }

  private listProviders() {
    return this.prisma.providerProfile.findMany({
      where: { status: { in: [...PUBLICLY_VISIBLE_PROVIDER_STATUSES] } },
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * One row per card on the air. A card has at most one live run (a partial
   * unique index guarantees it), and the run has to be on at least one active
   * shelf to be served at all — the same inner join the feed and the card
   * page make.
   */
  private async listLiveShowcaseCards(now: Date) {
    const rows = await this.prisma.$queryRaw<{ cardId: string }[]>(Prisma.sql`
      SELECT DISTINCT p."cardId" AS "cardId"
      FROM "ShowcasePlacement"   p
      JOIN "ShowcaseCard"        c  ON c."id"  = p."cardId"
      JOIN "ShowcaseCardVersion" v  ON v."id"  = p."pinnedVersionId"
      JOIN "ProviderProfile"     pr ON pr."id" = p."providerId"
      WHERE EXISTS (
              SELECT 1 FROM "ShowcasePlacementShelf" s
              WHERE s."placementId" = p."id" AND s."active"
            )
        AND ${livePlacementPredicate(now)}
      ORDER BY p."cardId" ASC
    `);

    return rows.map((row) => ({ cardId: row.cardId }));
  }
}
