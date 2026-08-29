import { Prisma } from '@prisma/client';

/**
 * The fixed shape of a provider application invitation.
 *
 * Everything here is a constant rather than an environment variable, and that
 * is the point. A link that grants the right to apply against an unreleased
 * service is a security decision, not a deployment preference: a deployment
 * that could set the lifetime to a year, or the entropy to sixteen bits, would
 * be a deployment that could weaken it silently.
 */

/**
 * How long a link stays usable, in days.
 *
 * Fourteen days is chosen against how the link is actually used: an operator
 * mails or messages it to one business and waits for that business to find the
 * time to fill in an application. A day or two would expire before a small firm
 * got round to it and turn every invitation into a support conversation; a
 * quarter would leave live links sitting in inboxes and forwarded threads long
 * after anybody remembered issuing them. Two weeks is one working fortnight —
 * long enough to be answered, short enough that a forgotten link dies on its
 * own.
 *
 * There is no way to extend one. An operator whose link expired issues another,
 * which is a new row with a new token, and the expired one stays in the list as
 * the record that it happened.
 */
export const PROVIDER_INVITE_TTL_DAYS = 14;

export const PROVIDER_INVITE_TTL_MS = PROVIDER_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * How many random bytes the raw token carries — 32, i.e. 256 bits.
 *
 * The token is the entire credential: whoever holds it may submit one
 * application against a service the public cannot see. 256 bits of
 * crypto-random makes guessing one indistinguishable from guessing a private
 * key, which is what lets the public route answer "no such link" identically
 * for a wrong guess and for a spent link without that answer ever being useful.
 */
export const PROVIDER_INVITE_TOKEN_BYTES = 32;

/**
 * Where a link lands. `apps/web/app/provider-invite/[token]`.
 *
 * The token is a path segment rather than a query parameter, which is the one
 * place in this flow it is visible at all. The page it lands on carries
 * `referrer: no-referrer` and `robots: noindex` for exactly that reason, and
 * the form on it moves the token into the request *body* from there on — so no
 * later request, and no third-party asset on the page, ever sees it in a URL.
 */
export const PROVIDER_INVITE_PATH = '/provider-invite';

/**
 * The state an invitation is in, as an admin screen may see it.
 *
 * Four values, and the public route collapses all but ACTIVE into one 404. The
 * distinction is an operator's to see — they issued the link — and nobody
 * else's.
 */
export type ProviderInviteState = 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';

export function providerInviteState(
  invite: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): ProviderInviteState {
  // Order matters, and this is the order the facts happened in. A link that was
  // used and then expired was used; a link revoked after it expired was already
  // dead, so the clock wins there. Nothing can be both used and revoked — the
  // consume refuses a revoked row and the revoke refuses a used one.
  if (invite.usedAt) {
    return 'USED';
  }

  if (invite.revokedAt) {
    return 'REVOKED';
  }

  return invite.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
}

/**
 * "Still usable", as a `where` fragment.
 *
 * The one definition of ACTIVE that runs in the database, next to the one above
 * that runs in TypeScript. Both are here so a reader can see they say the same
 * thing: the consume in ProviderInvitesService and the readiness count in
 * CategoriesService are the two places that ask, and they must never disagree
 * about which links are live.
 */
export function activeProviderInviteFilter(
  now: Date = new Date(),
): Prisma.ProviderInviteTokenWhereInput {
  return { usedAt: null, revokedAt: null, expiresAt: { gt: now } };
}
