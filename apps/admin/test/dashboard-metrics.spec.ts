import { describe, expect, it } from 'vitest';
import { buildAdminDashboardMetrics, resolveMetricTone } from '../lib/dashboard-metrics';
import {
  OPEN_SUPPORT_TICKETS_FILTER,
  OPEN_SUPPORT_TICKETS_HREF,
  OPEN_SUPPORT_TICKET_STATUSES,
  isOpenSupportTicketFilter,
} from '../lib/support-ticket-filter';
import type { AdminSummary } from '../lib/api';

/**
 * The dashboard's badges and the support card.
 *
 * The defect this covers is a dashboard that warned about nothing: a fresh
 * marketplace has zero pending requests, zero tickets in review and zero refund
 * candidates, and every one of those cards still wore a "dikkat" badge because
 * the tone was typed onto the card rather than derived from the count. The
 * cases below pin both halves of the replacement — a zero is silent, a positive
 * action metric is not — and they go through `buildAdminDashboardMetrics`, the
 * function the page actually calls, so a card that stopped using it would fail
 * here rather than pass on a helper nobody renders.
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

function metric(summary: Partial<AdminSummary>, key: string) {
  const found = buildAdminDashboardMetrics({ ...EMPTY_SUMMARY, ...summary }).find(
    (candidate) => candidate.key === key,
  );

  if (!found) throw new Error(`No dashboard metric named "${key}"`);
  return found;
}

describe('a count of zero', () => {
  it('leaves every card without a badge', () => {
    const metrics = buildAdminDashboardMetrics(EMPTY_SUMMARY);

    expect(metrics.every((entry) => entry.value === 0)).toBe(true);
    expect(metrics.filter((entry) => entry.tone !== 'neutral')).toEqual([]);
  });

  it.each(['pendingRequests', 'inReviewRequests', 'refundableOffers'])(
    'silences the action metric %s the brief names',
    (key) => {
      expect(metric({}, key).tone).toBe('neutral');
    },
  );
});

describe('a positive count', () => {
  it.each(['pendingRequests', 'inReviewRequests', 'pendingProviders', 'refundableOffers'])(
    'keeps the badge on %s',
    (key) => {
      expect(metric({ [key]: 3 }, key).tone).toBe('warning');
    },
  );

  it('leaves totals and standing counts alone, however large they get', () => {
    const summary = {
      totalRequests: 412,
      totalOffers: 980,
      packagePurchases: 37,
      approvedProviders: 128,
    };

    for (const key of Object.keys(summary)) {
      expect(metric(summary, key).tone).toBe('neutral');
    }
  });
});

describe('the open support tickets card', () => {
  it('is labelled and pointed at the admin queue, filtered to the backlog', () => {
    const card = metric({ openSupportTickets: 4 }, 'openSupportTickets');

    expect(card.label).toBe('Açık destek talepleri');
    expect(card.value).toBe(4);
    expect(card.href).toBe('/support?status=OPEN,IN_PROGRESS');
    expect(card.href).toBe(OPEN_SUPPORT_TICKETS_HREF);
  });

  /**
   * The card counts OPEN + IN_PROGRESS, so the list it opens has to select the
   * same two. This is the assertion that would have caught the mismatch it
   * replaced — a link naming only OPEN, under a number counting both.
   */
  it('asks the list for exactly the statuses the number counts', () => {
    expect([...OPEN_SUPPORT_TICKET_STATUSES]).toEqual(['OPEN', 'IN_PROGRESS']);
    expect(OPEN_SUPPORT_TICKETS_HREF).toBe(`/support?status=${OPEN_SUPPORT_TICKETS_FILTER}`);

    const filter = new URL(OPEN_SUPPORT_TICKETS_HREF, 'https://admin.test').searchParams.get(
      'status',
    );
    expect(filter?.split(',')).toEqual([...OPEN_SUPPORT_TICKET_STATUSES]);
  });

  it('leaves the answered and the filed out of the filter it opens', () => {
    expect(OPEN_SUPPORT_TICKETS_FILTER).not.toContain('RESOLVED');
    expect(OPEN_SUPPORT_TICKETS_FILTER).not.toContain('CLOSED');
  });

  it('keeps the address readable rather than percent-encoded', () => {
    expect(OPEN_SUPPORT_TICKETS_HREF).toContain(',');
    expect(OPEN_SUPPORT_TICKETS_HREF).not.toContain('%2C');
  });

  it('shows the number the summary carries, and a badge only while it is positive', () => {
    expect(metric({ openSupportTickets: 0 }, 'openSupportTickets').tone).toBe('neutral');
    expect(metric({ openSupportTickets: 1 }, 'openSupportTickets').tone).toBe('warning');
  });
});

describe('the badge rule itself', () => {
  it('says nothing for a metric that names no action, at any count', () => {
    expect(resolveMetricTone(0, undefined)).toBe('neutral');
    expect(resolveMetricTone(9000, undefined)).toBe('neutral');
  });

  it('treats a missing or nonsensical count as nothing to do', () => {
    expect(resolveMetricTone(Number.NaN, 'warning')).toBe('neutral');
    expect(resolveMetricTone(-1, 'warning')).toBe('neutral');
  });
});

describe('recognising the backlog filter', () => {
  it('accepts the two statuses in any order, with repeats', () => {
    expect(isOpenSupportTicketFilter(['OPEN', 'IN_PROGRESS'])).toBe(true);
    expect(isOpenSupportTicketFilter(['IN_PROGRESS', 'OPEN'])).toBe(true);
    expect(isOpenSupportTicketFilter(['OPEN', 'OPEN', 'IN_PROGRESS'])).toBe(true);
  });

  it('is not half of it, and not something wider', () => {
    expect(isOpenSupportTicketFilter(['OPEN'])).toBe(false);
    expect(isOpenSupportTicketFilter(['IN_PROGRESS'])).toBe(false);
    expect(isOpenSupportTicketFilter([])).toBe(false);
    expect(isOpenSupportTicketFilter(['OPEN', 'IN_PROGRESS', 'RESOLVED'])).toBe(false);
  });
});
