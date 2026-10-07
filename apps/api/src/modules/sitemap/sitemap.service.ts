import { Inject, Injectable } from '@nestjs/common';
import { isShowcaseShelfIndexable } from '../seo/seo-index-eligibility';
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
 *   categories     the public catalogue's ACTIVE leaves, then the category
 *                  rule of seo-index-eligibility.ts, read with the editorial
 *                  blocks SEO-004 gave a home to
 *   providers      the public status allow-list and the business rule, in
 *                  one query (SeoIndexEligibilityService)
 *   showcaseCards  the shelf's own "on the air" predicate and the card rule,
 *                  in one query (the same service)
 *   showcaseShelf  SEO-004: whether `/vitrin` itself is indexable — the shelf
 *                  rule over the same card answers. The web used to list
 *                  `/vitrin` unconditionally, beside a page whose own `<head>`
 *                  said `noindex`.
 *
 * The page behind each id reads its own `seoIndexable` from the same
 * functions, so a listed id is a page whose `<head>` says `index`, and a page
 * that says `noindex` is never listed. A category is listed under the slug it
 * has now; an address it had before is a redirect source, which is never a
 * page and never listed.
 *
 * ## Deliberately not a directory
 *
 * A slug, an id and the row's `updatedAt` — the two things a sitemap row is
 * made of — and no third field. Not the business name, not its city, not a
 * card's title or price: those are on the page behind the id, under that
 * page's public projection, and a second copy here would be a second place to
 * keep private.
 */
@Injectable()
export class SitemapService {
  constructor(@Inject(SeoIndexEligibilityService) private readonly eligibility: SeoIndexEligibilityService) {}

  async listEntries() {
    const now = new Date();
    const [categories, providers, showcaseCardIds] = await Promise.all([
      this.eligibility.listIndexableCategories(),
      this.eligibility.listIndexableProviders(),
      this.eligibility.listIndexableLiveShowcaseCardIds(now),
    ]);

    return {
      categories,
      providers,
      showcaseCards: showcaseCardIds.map((cardId) => ({ cardId })),
      showcaseShelf: { indexable: isShowcaseShelfIndexable(showcaseCardIds.length) },
    };
  }
}
