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
 * The API enforces the same rule since API-GUARD-REQUEST-001 (PR #119):
 * `PATCH /service-requests/:id/status` accepts IN_REVIEW and APPROVED only
 * from these three states with no accepted offer, and refuses anything else
 * with 409 REQUEST_STATUS_TRANSITION_NOT_ALLOWED. This list only decides which
 * buttons are drawn; a row that moved after the page was drawn is refused by
 * the API and explained on the screen (lib/status-conflicts.ts).
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
