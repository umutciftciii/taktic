import { Prisma } from '@prisma/client';
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
 * An area row matches when every level it names matches the request. A row with
 * a NULL district covers the whole city, and one with a NULL neighbourhood
 * covers the whole district — so a provider widens their reach by leaving the
 * finer level unset, never by listing more rows.
 */
export function matchesProviderArea(
  areas: readonly ProviderServiceAreaLike[],
  request: MatchableRequestLocation,
): boolean {
  return areas.some((area) => {
    if (!sameText(area.city, request.city)) {
      return false;
    }

    if (area.district && !sameText(area.district, request.district)) {
      return false;
    }

    if (area.neighborhood && !sameText(area.neighborhood, request.neighborhood)) {
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
