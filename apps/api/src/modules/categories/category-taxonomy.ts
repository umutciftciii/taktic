import { ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';

/**
 * The rules that turn a category's `kind` and `status` into permissions — in
 * one place, as pure functions, so the public listing, the request endpoint,
 * the router walk and provider onboarding cannot drift into three slightly
 * different answers to "may this category be used".
 *
 * Nothing here touches Prisma. Every function takes the two columns it reads
 * and nothing else, which is what lets the whole matrix be tested without a
 * database.
 */

/** The smallest shape any rule below needs. */
export type CategoryTaxonomyFacts = {
  kind: ServiceCategoryKind;
  status: ServiceCategoryStatus;
};

/**
 * The only kind a request, an offer, a credit charge, an accepted work scope or
 * a provider's service list may point at.
 *
 * GROUP is navigation and ROUTER is a question in category clothing; neither
 * describes work anybody performs, so neither may be the thing a provider is
 * matched on.
 */
export function isLeafCategory(category: CategoryTaxonomyFacts): boolean {
  return category.kind === ServiceCategoryKind.LEAF;
}

export function isRouterCategory(category: CategoryTaxonomyFacts): boolean {
  return category.kind === ServiceCategoryKind.ROUTER;
}

export function isGroupCategory(category: CategoryTaxonomyFacts): boolean {
  return category.kind === ServiceCategoryKind.GROUP;
}

/**
 * What the public category *list* returns: ACTIVE leaves.
 *
 * Deliberately narrower than {@link isPubliclyReachable}. A list is a catalogue
 * of things somebody can buy, and a router is not one of them — it is the
 * question that decides which of these leaves they meant.
 */
export function isPubliclyListable(category: CategoryTaxonomyFacts): boolean {
  return category.status === ServiceCategoryStatus.ACTIVE && isLeafCategory(category);
}

/**
 * What the public category *detail* endpoint serves: ACTIVE leaves and the
 * ACTIVE routers that lead to them.
 *
 * A router has to be reachable by slug or a routed flow could never begin; what
 * it must never be is a destination, which is what every other rule in this
 * file enforces. A GROUP is never served publicly at all.
 */
export function isPubliclyReachable(category: CategoryTaxonomyFacts): boolean {
  return (
    category.status === ServiceCategoryStatus.ACTIVE &&
    (isLeafCategory(category) || isRouterCategory(category))
  );
}

/**
 * Whether a request may *enter* the flow at this category.
 *
 * DRAFT is admin-only on purpose: that is what makes a draft category something
 * an admin can walk end to end before anybody else sees it, without the draft
 * being one misconfigured link away from taking real customer requests.
 * INACTIVE is closed to everyone, admins included — an admin who wants to take
 * requests again reactivates the category rather than working around it.
 */
export function canEnterFlow(category: CategoryTaxonomyFacts, isAdmin: boolean): boolean {
  if (isGroupCategory(category)) {
    return false;
  }

  if (category.status === ServiceCategoryStatus.ACTIVE) {
    return true;
  }

  return category.status === ServiceCategoryStatus.DRAFT && isAdmin;
}

/**
 * Whether a request may finally *land* on this category — the leaf that
 * matching, pricing and scope will read.
 */
export function canReceiveRequests(category: CategoryTaxonomyFacts, isAdmin: boolean): boolean {
  return isLeafCategory(category) && canEnterFlow(category, isAdmin);
}

/**
 * Whether a provider may newly select this category.
 *
 * ACTIVE leaves only, whoever is asking. A DRAFT category is not a service the
 * marketplace sells yet, and an INACTIVE one is one it has stopped selling —
 * neither is something to put in a provider's list. Providers already attached
 * to a category that later leaves ACTIVE keep the row: the past is readable,
 * and only *new* selections are refused.
 */
export function canBeSelectedByProviders(category: CategoryTaxonomyFacts): boolean {
  return isPubliclyListable(category);
}

/**
 * Whether a SUPER_ADMIN may bind a provider to this category by hand.
 *
 * Wider than {@link canBeSelectedByProviders} in exactly one direction: a DRAFT
 * leaf is assignable. That is what makes "does this unreleased service have
 * anybody behind it" a question an operator can answer *before* releasing it,
 * instead of a chicken-and-egg where the category must go live to collect the
 * providers that justify going live.
 *
 * Everything else is unchanged and deliberately so. A GROUP is a folder and a
 * ROUTER is a question — neither describes work, so neither may sit in a
 * provider's list whatever the caller's role. An INACTIVE category is one the
 * marketplace has stopped selling; binding a provider to it would be building
 * supply for something nobody may request.
 */
export function canBeAssignedByAdmin(category: CategoryTaxonomyFacts): boolean {
  return (
    isLeafCategory(category) &&
    (category.status === ServiceCategoryStatus.ACTIVE ||
      category.status === ServiceCategoryStatus.DRAFT)
  );
}

/**
 * Whether an existing provider↔category binding is part of the running
 * marketplace — the one rule that decides what a DRAFT binding is *for*.
 *
 * A DRAFT binding is a release-preparation fact and nothing else. It feeds the
 * operator's readiness count, and it is invisible everywhere else: it does not
 * put requests in front of the provider, does not let them offer, does not
 * appear in the provider's own profile or e-mails, and does not appear on the
 * public profile. The moment the category becomes ACTIVE the same row starts
 * counting for everything, with no data migration — which is the whole reason
 * this is a rule read at query time rather than a column on the binding.
 *
 * INACTIVE is deliberately *not* excluded here: closing a category is already
 * handled by the rules that refuse new requests and new offers, and rewriting
 * what an existing binding means would change behaviour this change is not
 * about.
 */
export function isLiveProviderBinding(
  category: Pick<CategoryTaxonomyFacts, 'status'>,
): boolean {
  return category.status !== ServiceCategoryStatus.DRAFT;
}

/** Turkish copy for the admin surfaces, so the same words appear everywhere. */
export const CATEGORY_STATUS_LABELS: Record<ServiceCategoryStatus, string> = {
  [ServiceCategoryStatus.DRAFT]: 'Taslak',
  [ServiceCategoryStatus.ACTIVE]: 'Yayında',
  [ServiceCategoryStatus.INACTIVE]: 'Kapalı',
};

export const CATEGORY_KIND_LABELS: Record<ServiceCategoryKind, string> = {
  [ServiceCategoryKind.GROUP]: 'Grup',
  [ServiceCategoryKind.LEAF]: 'Hizmet',
  [ServiceCategoryKind.ROUTER]: 'Yönlendirici',
};

/**
 * `status` and the legacy `isActive` boolean are the same fact. Everything that
 * writes one writes the other through here, so no code path can leave a
 * category ACTIVE-but-inactive.
 */
export function isActiveFor(status: ServiceCategoryStatus): boolean {
  return status === ServiceCategoryStatus.ACTIVE;
}
