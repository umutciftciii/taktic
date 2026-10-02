import { Prisma } from '@prisma/client';

export type ReportQueueState = 'open' | 'resolved';

/**
 * The report queue's two views as predicates over reports
 * (API-DASHBOARD-REQUEST-REPORT-COUNT-001). "Open" is a report nobody has
 * decided on; "resolved" is one with a decision.
 */
export function reportQueueStateWhere(state: ReportQueueState): Prisma.ServiceRequestReportWhereInput {
  return state === 'open' ? { resolvedAt: null } : { resolvedAt: { not: null } };
}

/**
 * The queue's unit is a *request*: every request with at least one report in
 * the state, counted once however many reports it has. `GET
 * /service-requests/reports` returns this as `total`, and the dashboard's
 * `reportedRequests` is the open view of it — so the dashboard number is the
 * number of rows the queue it links to holds. The older `openRequestReports`
 * counts reports, not requests, and is a different figure.
 */
export function reportedRequestWhere(state: ReportQueueState): Prisma.ServiceRequestWhereInput {
  return { reports: { some: reportQueueStateWhere(state) } };
}
