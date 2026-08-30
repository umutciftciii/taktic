import { Prisma, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';

/**
 * The rules that turn a category's `kind` and `status` into permissions — in
 * one place, as pure functions, so the public listing, the request endpoint,
 * the router walk and provider onboarding cannot drift into three slightly
 * different answers to "may this category be used".
 *
 * Nothing here runs a query. The functions take the columns they read and
 * nothing else, and the one Prisma value below is a plain `where` object — so
 * the whole matrix, that fragment included, is tested without a database.
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

/** The columns an enrollment decision reads. */
export type CategoryEnrollmentFacts = CategoryTaxonomyFacts & {
  providerEnrollmentOpen: boolean;
};

/**
 * Whether a provider may put this category in their own service list.
 *
 * An ACTIVE leaf is always open, and the stored column cannot close it. That is
 * not an oversight: provider selection is what every profile save and every new
 * application writes, so a checkbox able to close a live category would be one
 * misclick away from refusing saves nobody could explain. Closing a service is
 * done by closing the service — INACTIVE — which this rule already refuses.
 *
 * A DRAFT leaf is open only when an operator has opened it, and that is the
 * whole point of the column. It is how a business that signs itself up can join
 * a service the marketplace has not put in front of customers yet — the
 * repairer whose trade is in the next wave — without every unfinished draft
 * quietly collecting applications.
 *
 * GROUP is a folder and ROUTER is a question; neither describes work anybody
 * performs. INACTIVE is a service the marketplace has stopped selling. None of
 * the three is ever selectable, whatever the column says.
 *
 * Providers already attached to a category that later leaves this set keep the
 * row: the past is readable, and only *new* selections are refused.
 */
export function isProviderEnrollmentOpen(category: CategoryEnrollmentFacts): boolean {
  if (!isLeafCategory(category)) {
    return false;
  }

  if (category.status === ServiceCategoryStatus.ACTIVE) {
    return true;
  }

  return category.status === ServiceCategoryStatus.DRAFT && category.providerEnrollmentOpen;
}

/**
 * The same rule, as a Prisma filter.
 *
 * It exists so the enrollment catalogue and the selection gate cannot describe
 * two different sets. A filter that admits one row the predicate refuses is a
 * picker offering a category the API rejects; one that admits one fewer is a
 * category a provider may select and can never find. The unit test asserts the
 * two against each other for exactly that reason.
 */
export const providerEnrollmentCategoryWhere: Prisma.ServiceCategoryWhereInput = {
  kind: ServiceCategoryKind.LEAF,
  OR: [
    { status: ServiceCategoryStatus.ACTIVE },
    { status: ServiceCategoryStatus.DRAFT, providerEnrollmentOpen: true },
  ],
};

/**
 * Whether a provider may newly select this category — one name for the rule the
 * application form and the profile form are both held to. See
 * {@link isProviderEnrollmentOpen} for why it says what it says.
 */
export function canBeSelectedByProviders(category: CategoryEnrollmentFacts): boolean {
  return isProviderEnrollmentOpen(category);
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
