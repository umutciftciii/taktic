import { Inject, Injectable } from '@nestjs/common';
import { ProviderStatus, ServiceRequestStatus, SupportTicketStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async adminSummary() {
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
    ] = await Promise.all([
      this.prisma.serviceRequest.count(),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.SUBMITTED } }),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.IN_REVIEW } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.APPROVED } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.PENDING_REVIEW } }),
      this.prisma.offer.count(),
      // Offers the unviewed-offer worker will actually pay out on: inside the
      // policy, unviewed, unrefunded and past their own eligibility moment.
      // Each offer's moment, never the current setting — the same snapshot the
      // worker reads, so this figure and the worker cannot disagree. Without
      // those clauses this counted every fresh offer nobody had opened yet, and
      // every offer written before the policy existed — a figure labelled
      // "refundable" that named things that would never be refunded.
      this.prisma.offer.count({
        where: {
          unviewedRefundPolicy: true,
          creditSpentTransactionId: { not: null },
          creditRefundedTransactionId: null,
          creditRefundedAt: null,
          viewedAt: null,
          unviewedRefundEligibleAt: { lte: new Date() },
        },
      }),
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
    };
  }
}
