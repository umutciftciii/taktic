import { MatchRoundStatus, Prisma, RequestDeliveryMode } from '@prisma/client';
import { isLocationBound } from './delivery-mode';
import { isPhoneVerificationRequired } from '../modules/phone-verification/phone-verification.constants';

/**
 * Whether a provider may see a request — the single definition of that rule.
 *
 * It used to live inside ProvidersService, next to the discovery endpoints that
 * are its only caller. It moved here when a second caller appeared: the
 * fan-out that mails a newly approved request to the providers it matches. Two
 * copies of "who is allowed to see this" is the shape of a disclosure bug, so
 * there is one, and both the screen and the mail read it.
 *
 * The rules are unchanged, and this module deliberately does nothing else — it
 * holds no Prisma client and knows nothing about sending.
 */

export type ProviderServiceAreaLike = {
  city: string;
  district: string | null;
  neighborhood: string | null;
};

export type MatchableRequestLocation = {
  city: string;
  district: string;
  neighborhood: string | null;
};

/**
 * A request as location matching reads it. `deliveryMode` is part of the type
 * on purpose (MATCH-001): a caller that forgot to select it does not compile,
 * so no surface can quietly apply area filtering to a remote request.
 */
export type MatchableRequest = MatchableRequestLocation & {
  deliveryMode: RequestDeliveryMode;
};

/**
 * MATCH-001 — the location step of "may this provider see this request", the
 * one every provider-facing surface asks (discovery list, request detail, the
 * offer fast check and its in-transaction authority, the publish fan-out and
 * its send-time re-check).
 *
 * An ON_SITE request matches on the provider's service areas exactly as it
 * always did. A REMOTE request skips them — a provider with areas elsewhere,
 * or with none at all, is not refused by location. Nothing else is skipped:
 * approval, category binding, the verification and vitrin gates, the round
 * and the exclusion are separate predicates the callers still apply.
 */
export function matchesRequestLocation(
  areas: readonly ProviderServiceAreaLike[],
  request: MatchableRequest,
): boolean {
  if (!isLocationBound(request)) {
    return true;
  }
  return matchesProviderArea(areas, request);
}

/**
 * An area row matches when every level it names matches the request. A row with
 * a NULL district covers the whole city, and one with a NULL neighbourhood
 * covers the whole district — so a provider widens their reach by leaving the
 * finer level unset, never by listing more rows.
 *
 * B-02 — a request that names no neighbourhood is a district-wide request, and
 * a neighbourhood-scoped area in that same province and district takes it too.
 * The request does not say it is outside the provider's neighbourhood, and
 * refusing it left a published request that no neighbourhood provider ever saw
 * (4ca7ad76 had ruled the opposite way). The widening stops at the district:
 * province and district are still compared exactly, so it never reaches a
 * sibling district or another province. A request that does name a
 * neighbourhood is held to it exactly, as before.
 *
 * This is the matching rule only. `areaCovers` — whether one area contains
 * another, which the profile and showcase forms ask — is not widened.
 */
export function matchesProviderArea(
  areas: readonly ProviderServiceAreaLike[],
  request: MatchableRequestLocation,
): boolean {
  const requestNamesNeighborhood = Boolean(request.neighborhood?.trim());

  return areas.some((area) => {
    if (!sameText(area.city, request.city)) {
      return false;
    }

    if (area.district && !sameText(area.district, request.district)) {
      return false;
    }

    if (
      area.neighborhood &&
      requestNamesNeighborhood &&
      !sameText(area.neighborhood, request.neighborhood)
    ) {
      return false;
    }

    return true;
  });
}

/** Turkish-aware case folding: "İSTANBUL" and "istanbul" are one place. */
export function sameText(left: string | null, right: string | null): boolean {
  return (left ?? '').toLocaleLowerCase('tr-TR') === (right ?? '').toLocaleLowerCase('tr-TR');
}

/**
 * The verification gate, as a query fragment. Empty while
 * REQUIRE_PHONE_VERIFICATION is off, which is what keeps the flag's default
 * behaviour identical to the behaviour before it existed.
 */
export function phoneVerifiedRequestFilter(): Prisma.ServiceRequestWhereInput {
  return isPhoneVerificationRequired() ? { phoneVerifiedAt: { not: null } } : {};
}

/** The same gate, applied to a row already in hand. */
export function isRequestVisibleToProviders(request: { phoneVerifiedAt: Date | null }): boolean {
  return !isPhoneVerificationRequired() || request.phoneVerifiedAt !== null;
}

/**
 * The vitrin visibility gate, as a query fragment.
 *
 * `ServiceRequest.directShowcaseProviderId` names the one provider a request is
 * reserved for. NULL — which is every request the public form has ever produced
 * and every one it will produce — means "reserved for nobody", so this filter
 * leaves ordinary marketplace matching exactly as it was.
 *
 * Written as an `OR` rather than as two queries because it is one rule: a
 * provider sees the requests nobody reserved, plus the ones reserved for them.
 *
 * The gate is cleared by exactly one thing — the customer's explicit RELEASE
 * after their lead's deadline passed — and from that moment the request is
 * ordinary in every respect, this filter included.
 */
export function directShowcaseVisibilityFilter(
  providerId: string,
): Prisma.ServiceRequestWhereInput {
  return {
    OR: [{ directShowcaseProviderId: null }, { directShowcaseProviderId: providerId }],
  };
}

/** The same gate, applied to a row already in hand. */
export function isRequestVisibleToDirectGate(
  request: { directShowcaseProviderId?: string | null },
  providerId: string,
): boolean {
  const gate = request.directShowcaseProviderId ?? null;
  return gate === null || gate === providerId;
}

/**
 * REL-002 Faz 2 — the round gate, as a query fragment.
 *
 * A provider is offered a request only while its *current* match round is
 * OPEN and they have not offered **in that round**. An offer in an earlier
 * round does not hide a later one: a provider who lost Round 1 may bid in
 * Round 2. (Excluding a provider who failed a match is Faz 3's exclusion
 * model, not this filter.)
 *
 * The join is request → current round by primary key, then an anti-join on
 * `Offer(providerId, matchRoundId)` — the unique index — so it costs one index
 * probe per candidate, not a scan of the request's offers.
 */
export function currentRoundOpenForProviderFilter(
  providerId: string,
): Prisma.ServiceRequestWhereInput {
  return {
    currentRound: {
      status: MatchRoundStatus.OPEN,
      offers: { none: { providerId } },
    },
  };
}

/**
 * The same round gate for a row already in hand — the detail and the offer
 * paths. The provider's own offer in the round does not hide the detail (it
 * is how they see what they sent); the offer path refuses a second one.
 */
export function isCurrentRoundOpen(request: { currentRound: { status: MatchRoundStatus } }): boolean {
  return request.currentRound.status === MatchRoundStatus.OPEN;
}

/**
 * REL-002 Faz 3 — provider exclusion, the single definition.
 *
 * A provider whose match on a request failed (the customer reported a service
 * issue) may never act on that request again, in any later round, whatever is
 * later decided about the incident. Every provider-facing surface asks this
 * one question through one of the two forms below — the marketplace list, the
 * request detail, the offer transaction, the accept, the publish fan-out and
 * the send-time audience re-check — and the `Offer_round_open_guard` trigger
 * refuses an excluded provider's offer at the database whatever the writer.
 *
 * The anti-join is one probe of the `(requestId, providerId)` unique index.
 */
export function notExcludedFromRequestFilter(providerId: string): Prisma.ServiceRequestWhereInput {
  return { providerExclusions: { none: { providerId } } };
}

/** The same rule from the provider's side: requests this provider is not excluded from. */
export function providerNotExcludedFilter(requestId: string): Prisma.ProviderProfileWhereInput {
  return { requestExclusions: { none: { requestId } } };
}

/** The same rule for one (request, provider) pair, read with the caller's client. */
export async function isProviderExcluded(
  client: Pick<Prisma.TransactionClient, 'serviceRequestProviderExclusion'>,
  requestId: string,
  providerId: string,
): Promise<boolean> {
  const row = await client.serviceRequestProviderExclusion.findUnique({
    where: { requestId_providerId: { requestId, providerId } },
    select: { id: true },
  });
  return row !== null;
}
