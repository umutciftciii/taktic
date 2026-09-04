import type { AdminSummary } from './api';

/**
 * The dashboard's metric cards, decided in one place.
 *
 * Two rules used to live as `tone="warning"` typed onto each card in the page,
 * and neither survived contact with an empty marketplace: a queue with nothing
 * in it still wore a "dikkat" badge, so the dashboard shouted at an operator
 * about zero pending requests, zero tickets in review and zero refund
 * candidates. A badge that is always on says nothing when it matters.
 *
 * So the rules are stated once, here, and the page renders whatever this
 * returns:
 *
 *   1. A badge is an *action* signal. Only a metric that names work an operator
 *      can pick up carries one — `actionTone`. Totals and standing figures
 *      ("toplam talep", "onaylı hizmet verenler") are there to be read, and a
 *      badge on them is decoration that dilutes the ones that mean something.
 *   2. A badge appears only while the count is positive. Zero work is not a
 *      warning, and `resolveMetricTone` is the only place that decides it — a
 *      new card cannot forget the rule, because it never gets to state it.
 */

export type AdminMetricTone = 'neutral' | 'success' | 'warning' | 'error';

/** The tone a card may wear when it has something on it. Never `neutral`. */
export type AdminMetricActionTone = Exclude<AdminMetricTone, 'neutral'>;

export type AdminDashboardMetric = {
  /** Stable identity, used by the page as a React key and by the tests. */
  key: string;
  label: string;
  value: number;
  href: string;
  /** Already resolved: `neutral` means the card renders without a badge. */
  tone: AdminMetricTone;
};

type AdminMetricDefinition = {
  key: string;
  label: string;
  href: string;
  read: (summary: AdminSummary) => number;
  /**
   * Set only on a metric that names outstanding work. Left off deliberately for
   * totals and standing counts — see rule 1 above.
   */
  actionTone?: AdminMetricActionTone;
};

/**
 * Where the support card sends an operator.
 *
 * The card counts OPEN and IN_PROGRESS together, but the admin list takes one
 * status at a time — `ListSupportTicketsDto` has a single `status` field — and
 * this link deliberately stays inside that contract rather than inventing a
 * query the API would drop. OPEN is the half that has nobody on it yet, which
 * is the one an operator opening this card is going to.
 */
export const OPEN_SUPPORT_TICKETS_HREF = '/support?status=OPEN';

const ADMIN_DASHBOARD_METRICS: readonly AdminMetricDefinition[] = [
  { key: 'totalRequests', label: 'Toplam talep', href: '/requests', read: (s) => s.totalRequests },
  {
    key: 'pendingRequests',
    label: 'Bekleyen talepler',
    href: '/requests',
    read: (s) => s.pendingRequests,
    actionTone: 'warning',
  },
  {
    key: 'inReviewRequests',
    label: 'İncelemedeki talepler',
    href: '/requests',
    read: (s) => s.inReviewRequests,
    actionTone: 'warning',
  },
  {
    key: 'approvedProviders',
    label: 'Onaylı hizmet verenler',
    href: '/providers',
    read: (s) => s.approvedProviders,
  },
  {
    key: 'pendingProviders',
    label: 'Bekleyen hizmet verenler',
    href: '/providers',
    read: (s) => s.pendingProviders,
    actionTone: 'warning',
  },
  { key: 'totalOffers', label: 'Toplam teklif', href: '/offers', read: (s) => s.totalOffers },
  {
    key: 'refundableOffers',
    label: 'İade adayı',
    href: '/refund-scan',
    read: (s) => s.refundableOffers,
    actionTone: 'warning',
  },
  {
    key: 'packagePurchases',
    label: 'Paket talebi',
    href: '/package-purchases',
    read: (s) => s.packagePurchases,
  },
  {
    key: 'openSupportTickets',
    label: 'Açık destek talepleri',
    href: OPEN_SUPPORT_TICKETS_HREF,
    read: (s) => s.openSupportTickets,
    actionTone: 'warning',
  },
];

/**
 * The one place a badge is decided.
 *
 * A count that is missing, negative or not a number is treated as nothing to do
 * rather than as something to warn about: an API that stopped sending a field
 * should leave the dashboard quiet, not permanently alarmed.
 */
export function resolveMetricTone(
  value: number,
  actionTone: AdminMetricActionTone | undefined,
): AdminMetricTone {
  if (!actionTone) return 'neutral';
  if (!Number.isFinite(value) || value <= 0) return 'neutral';
  return actionTone;
}

/** Every dashboard card, in display order, with its badge already resolved. */
export function buildAdminDashboardMetrics(summary: AdminSummary): AdminDashboardMetric[] {
  return ADMIN_DASHBOARD_METRICS.map((definition) => {
    const raw = definition.read(summary);
    const value = Number.isFinite(raw) ? raw : 0;

    return {
      key: definition.key,
      label: definition.label,
      value,
      href: definition.href,
      tone: resolveMetricTone(value, definition.actionTone),
    };
  });
}
