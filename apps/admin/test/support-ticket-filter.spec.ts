import { describe, expect, it } from 'vitest';
import { buildAdminDashboardMetrics } from '../lib/dashboard-metrics';
import {
  OPEN_SUPPORT_TICKETS_FILTER,
  OPEN_SUPPORT_TICKETS_HREF,
  OPEN_SUPPORT_TICKET_STATUSES,
  buildSupportListHref,
  isOpenSupportTicketFilter,
  parseStatusFilter,
  statusFilterValue,
} from '../lib/support-ticket-filter';
import type { AdminSummary } from '../lib/api';

/**
 * The support list's `?status=` contract, from both ends.
 *
 * The defect this covers is a mismatch between a number and the screen behind
 * it: the dashboard card counted OPEN + IN_PROGRESS and its link said
 * `?status=OPEN`, so an operator who read "3" and clicked it landed on a list
 * of two. The claim under test is that **the statuses the card counts are
 * exactly the statuses the list it opens will select** — asserted by taking the
 * card's own href and running it through the parser the support page uses,
 * rather than by writing the expected set out twice.
 *
 * The other half is that widening the field widened nothing else: every shape
 * `?status=` could carry before still resolves to what it always did.
 */

const EMPTY_SUMMARY: AdminSummary = {
  totalRequests: 0,
  pendingRequests: 0,
  inReviewRequests: 0,
  approvedProviders: 0,
  pendingProviders: 0,
  totalOffers: 0,
  refundableOffers: 0,
  packagePurchases: 0,
  openSupportTickets: 0,
};

/** The `?status=` value carried by a href, exactly as a browser would read it. */
function statusParamOf(href: string): string | null {
  return new URL(href, 'https://admin.taktic.test').searchParams.get('status');
}

describe('the card and the list select the same tickets', () => {
  it('resolves the card’s own link to the statuses the card counts', () => {
    const card = buildAdminDashboardMetrics({ ...EMPTY_SUMMARY, openSupportTickets: 7 }).find(
      (metric) => metric.key === 'openSupportTickets',
    );

    expect(card).toBeDefined();

    // The page's parser, on the card's href: what the list would actually ask
    // the API for after following this link.
    const requested = parseStatusFilter(statusParamOf(card!.href) ?? undefined);

    expect(requested).toEqual([...OPEN_SUPPORT_TICKET_STATUSES]);
    expect(isOpenSupportTicketFilter(requested)).toBe(true);
  });

  it('asks for both halves of the backlog and neither finished state', () => {
    const requested = parseStatusFilter(statusParamOf(OPEN_SUPPORT_TICKETS_HREF) ?? undefined);

    expect(requested).toContain('OPEN');
    expect(requested).toContain('IN_PROGRESS');
    expect(requested).not.toContain('RESOLVED');
    expect(requested).not.toContain('CLOSED');
  });

  it('keeps the address legible enough to paste to somebody', () => {
    expect(OPEN_SUPPORT_TICKETS_HREF).toBe('/support?status=OPEN,IN_PROGRESS');
    expect(OPEN_SUPPORT_TICKETS_HREF).not.toContain('%2C');
    expect(statusFilterValue([...OPEN_SUPPORT_TICKET_STATUSES])).toBe(OPEN_SUPPORT_TICKETS_FILTER);
  });
});

describe('the single-status filter that existed before', () => {
  it.each(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const)(
    'still means exactly %s and nothing else',
    (status) => {
      expect(parseStatusFilter(status)).toEqual([status]);
    },
  );

  it('still builds the link it always built', () => {
    expect(buildSupportListHref(['OPEN'], 1)).toBe('/support?status=OPEN');
    expect(buildSupportListHref(['RESOLVED'], 3)).toBe('/support?status=RESOLVED&page=3');
    expect(buildSupportListHref([], 1)).toBe('/support');
    expect(buildSupportListHref([], 2)).toBe('/support?page=2');
  });

  it('round-trips: a link built from a filter parses back to that filter', () => {
    for (const statuses of [['OPEN'], ['CLOSED'], [...OPEN_SUPPORT_TICKET_STATUSES]] as const) {
      const href = buildSupportListHref(statuses, 1);
      expect(parseStatusFilter(statusParamOf(href) ?? undefined)).toEqual([...statuses]);
    }
  });
});

describe('what a `?status=` value may say', () => {
  it('reads a comma-separated set', () => {
    expect(parseStatusFilter('OPEN,IN_PROGRESS')).toEqual(['OPEN', 'IN_PROGRESS']);
  });

  it('reads the repeated-parameter form Next hands over as an array', () => {
    expect(parseStatusFilter(['OPEN', 'IN_PROGRESS'])).toEqual(['OPEN', 'IN_PROGRESS']);
  });

  it('tolerates spacing, casing and repeats', () => {
    expect(parseStatusFilter(' open , IN_PROGRESS , open ')).toEqual(['OPEN', 'IN_PROGRESS']);
  });

  it('treats an empty or unknown value as no filter, not as a filter matching nothing', () => {
    expect(parseStatusFilter('')).toEqual([]);
    expect(parseStatusFilter(undefined)).toEqual([]);
    expect(parseStatusFilter(',,')).toEqual([]);
    expect(parseStatusFilter('OPENN')).toEqual([]);
  });

  it('keeps the statuses it recognises out of a value that is partly rubbish', () => {
    expect(parseStatusFilter('OPEN,NOT_A_STATUS')).toEqual(['OPEN']);
  });
});
