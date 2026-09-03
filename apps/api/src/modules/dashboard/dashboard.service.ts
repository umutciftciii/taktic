import { Inject, Injectable } from '@nestjs/common';
import { ProviderStatus, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../offers/refund-policy';

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
    ] = await Promise.all([
      this.prisma.serviceRequest.count(),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.SUBMITTED } }),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.IN_REVIEW } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.APPROVED } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.PENDING_REVIEW } }),
      this.prisma.offer.count(),
      // Offers the unviewed-offer worker will actually pay out on: inside the
      // policy, unviewed, unrefunded and past the 48-hour window. Without those
      // last two clauses this counted every fresh offer nobody had opened yet,
      // and every offer written before the policy existed — a figure labelled
      // "refundable" that named things that would never be refunded.
      this.prisma.offer.count({
        where: {
          unviewedRefundPolicy: true,
          creditSpentTransactionId: { not: null },
          creditRefundedTransactionId: null,
          creditRefundedAt: null,
          viewedAt: null,
          submittedAt: {
            lte: new Date(Date.now() - UNVIEWED_OFFER_REFUND_WINDOW_HOURS * 60 * 60 * 1000),
          },
        },
      }),
      this.prisma.packagePurchase.count(),
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
    };
  }
}
