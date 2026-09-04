/**
 * The support list's status filter, and the backlog it can name.
 *
 * One module because the two are the same contract seen from both ends: what a
 * `?status=` value may say, and which value the dashboard's card points at. The
 * screen parses with `parseStatusFilter` and links with `buildSupportListHref`,
 * and so do the tests — so what is asserted is the contract the page actually
 * implements rather than a restatement of it.
 */

import { SUPPORT_TICKET_STATUSES, type SupportTicketStatus } from './api';

/**
 * The support backlog, defined once.
 *
 * A ticket is in the backlog while it is still somebody's job: OPEN — nobody
 * has picked it up — and IN_PROGRESS — somebody has. RESOLVED and CLOSED are
 * finished work and are deliberately outside it, because a figure that counts
 * answered tickets is one no operator can ever bring down.
 *
 * Three places read this list rather than restating it: the dashboard card's
 * link, the support list's own "açık talepler" filter option, and the tests
 * that assert the card's number and the list's rows are the same set. The API
 * counts the same two statuses in `DashboardService.adminSummary`, and
 * `apps/api/test/admin-dashboard-summary.spec.ts` holds the two halves
 * together.
 *
 */
export const OPEN_SUPPORT_TICKET_STATUSES: readonly SupportTicketStatus[] = [
  'OPEN',
  'IN_PROGRESS',
];

/**
 * The value of `?status=` that selects the backlog.
 *
 * A literal comma rather than `URLSearchParams` encoding: the address is meant
 * to be read and pasted, and `status=OPEN,IN_PROGRESS` says what it filters
 * where `status=OPEN%2CIN_PROGRESS` does not. A comma is a legal sub-delimiter
 * in a query string, and the API accepts this form alongside the single-status
 * one every older link still carries.
 */
export const OPEN_SUPPORT_TICKETS_FILTER = OPEN_SUPPORT_TICKET_STATUSES.join(',');

/** Where the dashboard's "Açık destek talepleri" card goes. */
export const OPEN_SUPPORT_TICKETS_HREF = `/support?status=${OPEN_SUPPORT_TICKETS_FILTER}`;

/** True when `statuses` is exactly the backlog, in any order and with repeats. */
export function isOpenSupportTicketFilter(statuses: readonly SupportTicketStatus[]): boolean {
  const chosen = new Set(statuses);
  return (
    chosen.size === OPEN_SUPPORT_TICKET_STATUSES.length &&
    OPEN_SUPPORT_TICKET_STATUSES.every((status) => chosen.has(status))
  );
}


/**
 * The statuses named by a `?status=` value, however it was written.
 *
 * Three shapes, one meaning — the same three the API's `ListSupportTicketsDto`
 * accepts, because this is the screen that builds the request it sends:
 *
 *     OPEN                     one status, the original contract
 *     OPEN,IN_PROGRESS         a comma-separated set
 *     ['OPEN', 'IN_PROGRESS']  repeated `?status=`, as Next hands it over
 *
 * Anything unrecognised is dropped rather than forwarded: a stale or
 * hand-edited link shows the unfiltered queue, which an operator can act on,
 * instead of a 400 from the API. Duplicates collapse and order is not kept —
 * the list's order is `lastActivityAt`, whatever the filter said.
 */
export function parseStatusFilter(value: string | string[] | undefined): SupportTicketStatus[] {
  const raw = Array.isArray(value) ? value : [value];

  const chosen = raw
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry): entry is SupportTicketStatus =>
      (SUPPORT_TICKET_STATUSES as readonly string[]).includes(entry),
    );

  return Array.from(new Set(chosen));
}

/** The `status` value a link carries: '' for no filter, otherwise comma-separated. */
export function statusFilterValue(statuses: readonly SupportTicketStatus[]): string {
  return statuses.join(',');
}

/**
 * A link back to the support list.
 *
 * Built by hand rather than with `URLSearchParams` so the comma between two
 * statuses survives as a comma: an operator sharing
 * `/support?status=OPEN,IN_PROGRESS` should be sharing something legible.
 */
export function buildSupportListHref(
  statuses: readonly SupportTicketStatus[],
  page: number,
): string {
  const parts: string[] = [];
  if (statuses.length) parts.push(`status=${statusFilterValue(statuses)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length ? `/support?${parts.join('&')}` : '/support';
}
