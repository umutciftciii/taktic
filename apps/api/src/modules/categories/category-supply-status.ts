import { ServiceCategoryStatus } from '@prisma/client';
import { isLeafCategory, type CategoryTaxonomyFacts } from './category-taxonomy';

/**
 * How far an unreleased service has got towards being one — computed on every
 * read and stored nowhere.
 *
 * A column would have been a copy of three facts that move independently: a
 * provider is approved, suspended or deleted; a binding is added or removed; a
 * price is set. Each of those is a write somebody has to remember, and a
 * forgotten one leaves a category reading "ready" with nobody behind it. Read
 * time is the only moment all three are true at once, which is why approving a
 * provider later needs no re-binding and no migration.
 *
 * EMPTY        No approved provider is attached. A pending, suspended or
 *              rejected profile is not one — none of them is ever shown a
 *              request — so binding one moves nothing, on purpose.
 * SUPPLY_READY Somebody can answer a request, but no offer can be paid for:
 *              the category has no price and refuses every offer.
 * LAUNCH_READY Both halves are in place. Still not published — that stays an
 *              operator's explicit act, and nothing here performs it.
 * LIVE         Published. Whether it also has supply is a different sentence,
 *              and the release checklist is the one that says it.
 */
export type CategorySupplyStatus = 'EMPTY' | 'SUPPLY_READY' | 'LAUNCH_READY' | 'LIVE';

export type CategorySupplyFacts = CategoryTaxonomyFacts & {
  /** NULL means "price never set", which blocks offering. See the schema. */
  offerCreditCost: number | null;
  /** APPROVED providers only — see the count the operator projection builds. */
  approvedProviderCount: number;
};

/**
 * `null` for everything this question does not apply to.
 *
 * A GROUP is a folder and a ROUTER is a question: neither carries a price, a
 * provider or a request, so "how ready is its supply" has no answer rather than
 * a bad one. An INACTIVE category is one the marketplace has stopped selling —
 * measuring its supply would be reporting on a decision already taken.
 */
export function resolveCategorySupplyStatus(
  facts: CategorySupplyFacts,
): CategorySupplyStatus | null {
  if (!isLeafCategory(facts)) {
    return null;
  }

  if (facts.status === ServiceCategoryStatus.INACTIVE) {
    return null;
  }

  if (facts.status === ServiceCategoryStatus.ACTIVE) {
    return 'LIVE';
  }

  if (facts.approvedProviderCount < 1) {
    return 'EMPTY';
  }

  // The database CHECK constraint makes 0 and negatives unrepresentable, so
  // "priced" and "not null" are the same question and there is no third branch.
  return facts.offerCreditCost === null ? 'SUPPLY_READY' : 'LAUNCH_READY';
}
