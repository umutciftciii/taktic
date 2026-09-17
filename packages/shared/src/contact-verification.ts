/**
 * Whether an account's e-mail or phone stands verified, read from its one
 * canonical column — `User.emailVerifiedAt` or `User.phoneVerifiedAt`.
 *
 * Every badge on every screen goes through this so they cannot disagree, and
 * so nothing else — a verified request, a consumed one-time code, a guess from
 * the account's age — can ever be read as proof. The unverified state is a
 * neutral fact, not a failure: the word is "Doğrulanmadı", never "Başarısız".
 */

export const VERIFIED_LABEL = 'Doğrulandı';
export const UNVERIFIED_LABEL = 'Doğrulanmadı';

export type ContactVerification = {
  verified: boolean;
  label: typeof VERIFIED_LABEL | typeof UNVERIFIED_LABEL;
  /** The proof's instant as an ISO string, or null when there is none. */
  at: string | null;
};

export function contactVerification(
  verifiedAt: string | Date | null | undefined,
): ContactVerification {
  const at = toIso(verifiedAt);
  return at
    ? { verified: true, label: VERIFIED_LABEL, at }
    : { verified: false, label: UNVERIFIED_LABEL, at: null };
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
