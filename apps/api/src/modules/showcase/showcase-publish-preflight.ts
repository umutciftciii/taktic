import { Prisma, ServiceCategoryKind, ShowcaseCardKind } from '@prisma/client';
import { areaCovers, describeArea } from '../../common/provider-service-area-scope';
import {
  canReceiveRequests,
  isActiveFor,
  type CategoryTaxonomyFacts,
} from '../categories/category-taxonomy';
import { showcaseAreaNotCovered, showcaseCategoryNotOffered } from './showcase.errors';

/**
 * The two checks that have to hold at the moment a card goes on the air, shared
 * by the operator's approval and the provider's "publish an approved card"
 * action. They used to live in the card-bound checkout; the moment of truth is
 * now the moment the placement is born, not the moment money moves.
 */
export function assertCategoryStillOpen(
  category: CategoryTaxonomyFacts,
  cardKind: ShowcaseCardKind,
) {
  if (cardKind === ShowcaseCardKind.PROMOTION && category.kind === ServiceCategoryKind.GROUP) {
    if (!isActiveFor(category.status)) {
      throw showcaseCategoryNotOffered();
    }
    return;
  }

  if (!canReceiveRequests(category, false)) {
    throw showcaseCategoryNotOffered();
  }
}

/** Every area the version claims must still sit inside the provider's own coverage. */
export async function assertVersionAreasCovered(
  db: Prisma.TransactionClient,
  providerId: string,
  versionId: string,
) {
  const [coverage, areas] = await Promise.all([
    db.providerServiceArea.findMany({
      where: { providerId },
      select: { city: true, district: true, neighborhood: true },
    }),
    db.showcaseCardVersionArea.findMany({
      where: { cardVersionId: versionId },
      select: { city: true, district: true, neighborhood: true },
    }),
  ]);

  for (const area of areas) {
    if (!coverage.some((owned) => areaCovers(owned, area))) {
      throw showcaseAreaNotCovered(describeArea(area));
    }
  }
}
