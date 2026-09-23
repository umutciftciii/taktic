import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminPackageRefundRequestsController } from './admin-package-refund-requests.controller';
import { PackageRefundEligibilityService } from './package-refund-eligibility.service';
import { PackageRefundRequestsService } from './package-refund-requests.service';
import { PackageRefundSettlementService } from './package-refund-settlement.service';
import { ProviderPackageRefundController } from './provider-package-refund.controller';

/**
 * CMP-006 — package *money* refunds. Distinct from the offer *credit* refund
 * (`offers/refund-policy.ts`, `OfferRefundSettlement`), which this module never
 * touches.
 *
 * PR-A: the canonical eligibility evaluation. PR-B: the refund request on a
 * support ticket, its state machine and permissioned review surface, and the
 * webhook-only settlement the payments module calls. Nothing in this module
 * moves money or credit.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminPackageRefundRequestsController, ProviderPackageRefundController],
  providers: [PackageRefundEligibilityService, PackageRefundRequestsService, PackageRefundSettlementService],
  exports: [PackageRefundEligibilityService, PackageRefundRequestsService, PackageRefundSettlementService],
})
export class PackageRefundsModule {}
