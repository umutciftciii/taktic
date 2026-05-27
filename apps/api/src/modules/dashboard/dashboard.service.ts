import { Inject, Injectable } from '@nestjs/common';
import { ProviderStatus, ServiceRequestStatus } from '@prisma/client';
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
    ] = await Promise.all([
      this.prisma.serviceRequest.count(),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.SUBMITTED } }),
      this.prisma.serviceRequest.count({ where: { status: ServiceRequestStatus.IN_REVIEW } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.APPROVED } }),
      this.prisma.providerProfile.count({ where: { status: ProviderStatus.PENDING_REVIEW } }),
      this.prisma.offer.count(),
      this.prisma.offer.count({
        where: {
          creditSpentTransactionId: { not: null },
          creditRefundedTransactionId: null,
          creditRefundedAt: null,
          viewedAt: null,
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
