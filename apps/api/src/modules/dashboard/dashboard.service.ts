import { Inject, Injectable } from '@nestjs/common';
import { AdminPermission, ProviderStatus, ServiceRequestStatus, SupportTicketStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { mayEmbed } from '../auth/embedded-permissions';
import { refundCandidateWhere } from '../offers/refund-policy';
import { reportedRequestWhere } from '../request-reports/request-report-queue';
import { showcaseReviewQueueWhere } from '../showcase/showcase-review-queue';

@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The dashboard's counts (DASHBOARD_READ).
   *
   * ADMIN-BACKEND-TRUTH-001: every action count is read from the predicate its
   * target list reads, so a number and the list it links to cannot disagree —
   * `refundableOffers` is the refund scan's `total`, `reportedRequests` the
   * open report queue's `total`, `pendingShowcaseReviews` the vitrin review
   * queue's length.
   *
   * The two queue counts added here are facts about lists behind their own
   * read permissions, so they follow the cross-domain projection rule
   * (`mayEmbed`): a caller without the list's permission gets no key at all,
   * not a zero. The older fields keep their shape.
   */
  async adminSummary(viewer: AuthUser | null = null) {
    const now = new Date();
    const mayReadShowcaseQueue = mayEmbed(viewer, AdminPermission.SHOWCASE_REVIEW_READ);
    const mayReadReportQueue = mayEmbed(viewer, AdminPermission.REQUEST_REPORTS_READ);
    const [
      totalRequests,
      pendingRequests,
      inReviewRequests,
      approvedProviders,
      pendingProviders,
      totalOffers,
      refundableOffers,
      packagePurchases,
      openSupportTickets,
      openRequestReports,
      reportedRequests,
      pendingShowcaseReviews,
    ] = await Promise.all([
      this.prisma.serviceRequest.count(),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.SUBMITTED } }),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.IN_REVIEW } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.APPROVED } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.PENDING_REVIEW } }),
      this.prisma.offer.count(),
      // Offers the unviewed-offer worker will actually pay out on — the
      // refund scan's own predicate, so this is the scan's `total` and the
      // run's candidate set (API-REFUND-SCAN-PAGINATION-001). Each offer's own
      // eligibility moment, never the current setting.
      this.prisma.offer.count({ where: refundCandidateWhere(now) }),
      this.prisma.packagePurchase.count(),
      // The support queue's backlog: the two statuses a ticket sits in while it
      // is still somebody's job. RESOLVED and CLOSED are deliberately outside
      // the count — a resolved ticket has been answered and a closed one is
      // filed, so counting either would put a number on the dashboard that no
      // operator can bring down.
      this.prisma.supportTicket.count({
        where: {
          status: { in: [SupportTicketStatus.OPEN, SupportTicketStatus.IN_PROGRESS] },
        },
      }),
      // Reports nobody has decided on, counted per *report*. Kept as it was;
      // the dashboard's queue cell reads `reportedRequests` below, which
      // counts in the queue's own unit.
      this.prisma.serviceRequestReport.count({ where: { resolvedAt: null } }),
      // Requests with at least one undecided report, each counted once — the
      // open report queue's rows (API-DASHBOARD-REQUEST-REPORT-COUNT-001).
      mayReadReportQueue
        ? this.prisma.serviceRequest.count({ where: reportedRequestWhere('open') })
        : Promise.resolve(null),
      // Card versions waiting on an operator — the vitrin review queue's rows
      // (API-DASHBOARD-SHOWCASE-QUEUE-001).
      mayReadShowcaseQueue
        ? this.prisma.showcaseCardVersion.count({ where: showcaseReviewQueueWhere() })
        : Promise.resolve(null),
    ]);

    return {
      totalRequests,
      pendingRequests,
      inReviewRequests,
      approvedProviders,
      pendingProviders,
      totalOffers,
      refundableOffers,
      packagePurchases,
      openSupportTickets,
      openRequestReports,
      ...(reportedRequests === null ? {} : { reportedRequests }),
      ...(pendingShowcaseReviews === null ? {} : { pendingShowcaseReviews }),
    };
  }
}
