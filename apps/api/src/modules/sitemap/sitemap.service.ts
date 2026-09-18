import { Inject, Injectable } from '@nestjs/common';
import { CategoriesService } from '../categories/categories.service';
import { isCategoryIndexable } from '../seo/seo-index-eligibility';
import { SeoIndexEligibilityService } from '../seo/seo-index-eligibility.service';

/**
 * What the web's `sitemap.xml` is built from: the identifiers of every record
 * that has a public page worth indexing right now, and nothing about the
 * record itself.
 *
 * ## Two questions per record, neither answered here
 *
 * A record is listed when it is public *and* index-eligible (SEO-003):
 *
 *   categories     the public catalogue as `GET /categories` serves it —
 *                  ACTIVE leaves, through the same service method — then the
 *                  category rule of seo-index-eligibility.ts, which no
 *                  category passes until the editorial blocks exist (B4)
 *   providers      the public status allow-list and the business rule, in
 *                  one query (SeoIndexEligibilityService)
 *   showcaseCards  the shelf's own "on the air" predicate and the card rule,
 *                  in one query (the same service)
 *
 * The page behind each id reads its own `seoIndexable` from the same
 * functions, so a listed id is a page whose `<head>` says `index`, and a page
 * that says `noindex` is never listed.
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
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(SeoIndexEligibilityService) private readonly eligibility: SeoIndexEligibilityService,
  ) {}

  async listEntries() {
    const now = new Date();
    const [categories, providers, showcaseCardIds] = await Promise.all([
      this.listCategories(),
      this.eligibility.listIndexableProviders(),
      this.eligibility.listIndexableLiveShowcaseCardIds(now),
    ]);

    return { categories, providers, showcaseCards: showcaseCardIds.map((cardId) => ({ cardId })) };
  }

  private async listCategories() {
    const listed = await this.categories.listCategories({ isSuperAdmin: false });
    return listed
      // No editorial blocks are stored yet, so this filters every category out
      // today; it is written anyway, so the sitemap and the page agree by
      // construction rather than by two separate "not yet"s.
      .filter((category) => isCategoryIndexable(category))
      .map((category) => ({ slug: category.slug, updatedAt: category.updatedAt }));
  }
}
