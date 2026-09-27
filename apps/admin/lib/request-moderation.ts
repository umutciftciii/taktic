/**
 * Which moderation moves the request screen offers ("İncelemeye al",
 * "Onayla"), by the request's current status.
 *
 * Moderation is the pre-market queue: a request the customer has sent
 * (SUBMITTED) is reviewed (IN_REVIEW) and published (APPROVED), and an
 * operator may move it between those three. Every other status belongs to a
 * flow of its own, and the screen does not offer a moderation move out of it:
 *
 * - DRAFT: the customer has not sent it yet.
 * - MATCHED, COMPLETED: a customer accepted an offer. Re-approving would put
 *   a matched request back on the market while it still points at the accepted
 *   offer.
 * - REJECTED: taken off the market with its offers closed and refunded; a
 *   report removal is put back through "Talebi geri aç" (REQUESTS_REOPEN), not
 *   through moderation.
 * - CANCELLED, EXPIRED: closed.
 *
 * This is the screen's rule, not the API's. `PATCH /service-requests/:id/status`
 * checks no source status for IN_REVIEW or APPROVED today, so a direct call can
 * still make every one of these moves; the guard belongs in the API and is a
 * separate backend item (docs/superpowers/specs/2026-09-28-admin-actions-001-007-inventory.md §3).
 */

export type ModerationTarget = 'IN_REVIEW' | 'APPROVED';

/** The statuses a moderation move may start from. */
export const MODERATION_SOURCE_STATUSES: ReadonlySet<string> = new Set(['SUBMITTED', 'IN_REVIEW', 'APPROVED']);

/** Whether the request is in the moderation queue at all. */
export function isInModeration(status: string): boolean {
  return MODERATION_SOURCE_STATUSES.has(status);
}

/**
 * How one moderation button is drawn: `hidden` outside the queue, `current`
 * (shown, disabled, "Mevcut") when the request is already there, `available`
 * otherwise.
 */
export function moderationMove(current: string, target: ModerationTarget): 'hidden' | 'current' | 'available' {
  if (!isInModeration(current)) return 'hidden';
  return current === target ? 'current' : 'available';
}
