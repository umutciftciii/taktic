import { Prisma, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import { PUBLICLY_VISIBLE_PROVIDER_STATUSES } from '../providers/provider-visibility';
import { livePlacementPredicate } from '../showcase/showcase-live-placement';
import { categoryPath, seoPageRef, type SeoPageRef } from './seo-paths';

/**
 * SEO-004 — "does this canonical path answer 200 right now", for a batch of
 * paths, with the same visibility rules the public pages apply:
 *
 *   /, /categories, /vitrin     always (the pages render whatever the data)
 *   /categories/:slug           an ACTIVE leaf or router (isPubliclyReachable)
 *   /isletme/:id                a publicly visible business (APPROVED)
 *   /vitrin/:cardId             a card on the air (livePlacementPredicate and
 *                               an active shelf row — the feed's own join)
 *
 * Any other path is not a page at all, and so not live. Used for both sides
 * of a redirect: a target must be live, a source must not be.
 */

type Db = Pick<Prisma.TransactionClient, 'serviceCategory' | 'providerProfile' | '$queryRaw'>;

/** Every path in `paths` that is a live page now. */
export async function livePaths(db: Db, paths: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  const refs = new Map<string, SeoPageRef>();
  for (const path of new Set(paths)) {
    const ref = seoPageRef(path);
    if (ref) refs.set(path, ref);
  }

  const slugs: string[] = [];
  const providerIds: string[] = [];
  const cardIds: string[] = [];
  const live = new Set<string>();
  for (const [path, ref] of refs) {
    switch (ref.kind) {
      case 'HOME':
      case 'CATALOGUE':
      case 'SHELF':
        live.add(path);
        break;
      case 'CATEGORY':
        slugs.push(ref.slug);
        break;
      case 'PROVIDER':
        providerIds.push(ref.id);
        break;
      case 'SHOWCASE_CARD':
        cardIds.push(ref.cardId);
        break;
    }
  }

  const [categories, providers, cards] = await Promise.all([
    slugs.length
      ? db.serviceCategory.findMany({
          where: {
            slug: { in: slugs },
            status: ServiceCategoryStatus.ACTIVE,
            kind: { in: [ServiceCategoryKind.LEAF, ServiceCategoryKind.ROUTER] },
          },
          select: { slug: true },
        })
      : Promise.resolve([]),
    providerIds.length
      ? db.providerProfile.findMany({
          where: { id: { in: providerIds }, status: { in: [...PUBLICLY_VISIBLE_PROVIDER_STATUSES] } },
          select: { id: true },
        })
      : Promise.resolve([]),
    cardIds.length
      ? db.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT DISTINCT c."id" AS "id"
          FROM "ShowcasePlacement"   p
          JOIN "ShowcaseCard"        c  ON c."id"  = p."cardId"
          JOIN "ShowcaseCardVersion" v  ON v."id"  = p."pinnedVersionId"
          JOIN "ProviderProfile"     pr ON pr."id" = p."providerId"
          WHERE c."id" IN (${Prisma.join(cardIds)})
            AND EXISTS (
              SELECT 1 FROM "ShowcasePlacementShelf" s
              WHERE s."placementId" = p."id" AND s."active"
            )
            AND ${livePlacementPredicate(now)}`)
      : Promise.resolve([]),
  ]);

  for (const { slug } of categories) live.add(categoryPath(slug));
  for (const { id } of providers) live.add(`/isletme/${id}`);
  for (const { id } of cards) live.add(`/vitrin/${id}`);
  return live;
}

export async function isLivePath(db: Db, path: string, now: Date = new Date()): Promise<boolean> {
  return (await livePaths(db, [path], now)).has(path);
}
