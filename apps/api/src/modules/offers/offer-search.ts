import { Prisma } from '@prisma/client';
import { type AdminTextSearch, phoneColumnMatchers } from '../../common/admin-search';

/**
 * OFFERS-SEARCH-OPT-001: the operator's offer search, written once.
 *
 * The box is matched against three tables: the offer's own id, its provider
 * (the provider's id, business name and — with PROVIDERS_READ — contact person
 * and phone) and its request (the request's id, city, district and — with
 * REQUESTS_READ — the customer's name, phone and e-mail snapshot). Each table's
 * conditions are built by exactly one function below, and both shapes of the
 * search are built from them:
 *
 * - **resolved** ({@link resolveOfferSearchWhere}): each table is asked first,
 *   on its own, for the ids it matches; the offer query then reads
 *   `id IN (…) OR providerId IN (…) OR requestId IN (…)`. Every arm is an
 *   index condition on `Offer`, so the planner can combine them (BitmapOr)
 *   instead of joining the provider and the request to every offer and
 *   evaluating the OR row by row — which is what made each of the list's five
 *   statements read the whole offer table.
 * - **joined** ({@link joinedOfferSearchWhere}): the same conditions as
 *   relation filters, which Prisma renders as LEFT JOINs. It is the shape the
 *   list ran before (there the provider or request was joined once per
 *   searched column), and what a table falls back to when it matches too
 *   many rows for an id list (see {@link OFFER_SEARCH_ID_LIST_LIMIT}); the list
 *   also uses it when a provider or request filter has already narrowed the
 *   offers to a few.
 *
 * The two shapes match the same offers: `Offer.providerId` and
 * `Offer.requestId` are required foreign keys, so an offer's provider and
 * request always exist, and "the offer's `providerId` contains the box" is
 * "its provider's `id` contains the box".
 *
 * A contact column the caller may not read is not in the conditions at all —
 * neither in the resolver's statement nor in the join — so whether a search
 * for it returns a row cannot confirm it.
 */

/**
 * The longest id list one table may hand the offer query.
 *
 * The bound is the statement's: Prisma binds every value of an `IN` list as
 * its own parameter, and PostgreSQL refuses a statement with more than 32767.
 * Three tables at this bound stay well under it with the list's other filters.
 * Measured on 60k providers / 180k requests / 450k offers, a full list costs
 * the offer statements a few milliseconds each, far below the join it
 * replaces. A table that matches more ("a", a city name) keeps its join — the
 * search is then as broad as it reads, and every row it matches is still
 * found: nothing is cut off.
 */
export const OFFER_SEARCH_ID_LIST_LIMIT = 5000;

/** Which contact columns the caller may search (see `offerEmbedScope`). */
export type OfferSearchScope = {
  /** PROVIDERS_READ: the provider's contact person and phone. */
  providerContact: boolean;
  /** REQUESTS_READ: the customer's name, phone and e-mail on the request. */
  requestDetail: boolean;
};

/** The offer's own column: its id. */
export function offerOwnSearchWhere(search: AdminTextSearch): Prisma.OfferWhereInput {
  return { id: { contains: search.text, mode: 'insensitive' } };
}

/** The provider's columns an offer is found by. */
export function offerProviderSearchWhere(
  search: AdminTextSearch,
  scope: OfferSearchScope,
): Prisma.ProviderProfileWhereInput {
  return {
    OR: [
      { id: { contains: search.text, mode: 'insensitive' } },
      { businessName: { contains: search.text, mode: 'insensitive' } },
      { businessNameSearch: { contains: search.folded } },
      ...(scope.providerContact
        ? ([
            { contactName: { contains: search.text, mode: 'insensitive' } },
            { contactNameSearch: { contains: search.folded } },
            ...phoneColumnMatchers(search).map((phone) => ({ phone })),
          ] satisfies Prisma.ProviderProfileWhereInput[])
        : []),
    ],
  };
}

/** The request's columns an offer is found by. */
export function offerRequestSearchWhere(
  search: AdminTextSearch,
  scope: OfferSearchScope,
): Prisma.ServiceRequestWhereInput {
  return {
    OR: [
      { id: { contains: search.text, mode: 'insensitive' } },
      ...(scope.requestDetail
        ? ([
            { customerName: { contains: search.text, mode: 'insensitive' } },
            { customerNameSearch: { contains: search.folded } },
            ...phoneColumnMatchers(search).map((customerPhone) => ({ customerPhone })),
            { customerEmail: { contains: search.text, mode: 'insensitive' } },
          ] satisfies Prisma.ServiceRequestWhereInput[])
        : []),
      { city: { contains: search.text, mode: 'insensitive' } },
      { citySearch: { contains: search.folded } },
      { district: { contains: search.text, mode: 'insensitive' } },
      { districtSearch: { contains: search.folded } },
    ],
  };
}

/** The search as relation filters: the offer joined to its provider and request. */
export function joinedOfferSearchWhere(search: AdminTextSearch, scope: OfferSearchScope): Prisma.OfferWhereInput {
  return {
    OR: [
      offerOwnSearchWhere(search),
      { provider: { is: offerProviderSearchWhere(search, scope) } },
      { request: { is: offerRequestSearchWhere(search, scope) } },
    ],
  };
}

/**
 * The search with each table's matches resolved to ids first.
 *
 * Run it on the transaction that reads the list: the ids are then the ones the
 * list's own snapshot holds, and the counts, the page and the figures all see
 * the same match. The ids are not read back into anything but the offer
 * query's `IN` list, and each list is at most {@link OFFER_SEARCH_ID_LIST_LIMIT}
 * long; a table that matches more is searched through its join instead.
 * `limit` is that bound; only the tests pass a smaller one, to reach the
 * fallback without thousands of rows.
 */
export async function resolveOfferSearchWhere(
  tx: Prisma.TransactionClient,
  search: AdminTextSearch,
  scope: OfferSearchScope,
  limit: number = OFFER_SEARCH_ID_LIST_LIMIT,
): Promise<Prisma.OfferWhereInput> {
  const take = limit + 1;

  const ownWhere = offerOwnSearchWhere(search);
  const offers = await tx.offer.findMany({ where: ownWhere, select: { id: true }, take });

  const providerWhere = offerProviderSearchWhere(search, scope);
  const providers = await tx.providerProfile.findMany({ where: providerWhere, select: { id: true }, take });

  const requestWhere = offerRequestSearchWhere(search, scope);
  const requests = await tx.serviceRequest.findMany({ where: requestWhere, select: { id: true }, take });

  const arms: Prisma.OfferWhereInput[] = [];
  if (offers.length > limit) {
    arms.push(ownWhere);
  } else if (offers.length > 0) {
    arms.push({ id: { in: offers.map((row) => row.id) } });
  }
  if (providers.length > limit) {
    arms.push({ provider: { is: providerWhere } });
  } else if (providers.length > 0) {
    arms.push({ providerId: { in: providers.map((row) => row.id) } });
  }
  if (requests.length > limit) {
    arms.push({ request: { is: requestWhere } });
  } else if (requests.length > 0) {
    arms.push({ requestId: { in: requests.map((row) => row.id) } });
  }

  // No table matched: no offer can. Said explicitly — Prisma drops an empty
  // `OR` inside an `AND`, which would turn "no match" into "every offer".
  if (arms.length === 0) return { id: { in: [] } };
  return { OR: arms };
}
