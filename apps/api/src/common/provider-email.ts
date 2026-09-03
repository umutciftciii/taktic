import { isEmail } from 'class-validator';
import { normalizeAccountEmail } from './account-email';

/**
 * The one normalisation for a provider application's contact address.
 *
 * `User.email` is stored lower-cased and is globally unique, and the claim flow
 * decides who may take an application over by comparing the two. A comparison
 * between a trimmed-but-not-folded value and a folded one silently fails for
 * anybody who typed a capital letter, so both sides fold here.
 *
 * Kept in `common/` rather than in either module because the providers module
 * writes the value and the claim module reads it, and neither may own the
 * definition alone. It is deliberately the *same* function an account address
 * goes through rather than a second one that happens to agree today: the whole
 * point is that an application's address and an account's address compare
 * equal, and two independent definitions could only ever drift apart.
 */
export function normalizeProviderEmail(value: string | null | undefined): string | null {
  return normalizeAccountEmail(value);
}

export function isValidProviderEmail(value: string): boolean {
  return isEmail(value);
}

/** Case-insensitive equality for two already-stored addresses. */
export function sameProviderEmail(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return normalizeProviderEmail(left) === normalizeProviderEmail(right);
}
