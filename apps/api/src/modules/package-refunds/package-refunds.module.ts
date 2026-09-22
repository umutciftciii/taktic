import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PackageRefundEligibilityService } from './package-refund-eligibility.service';

/**
 * CMP-006 — package *money* refunds. Distinct from the offer *credit* refund
 * (`offers/refund-policy.ts`, `OfferRefundSettlement`), which this module never
 * touches.
 *
 * PR-A ships only the canonical eligibility evaluation, with no route: the
 * refund-request flow and its permissioned review surface are PR-B.
 */
@Module({
  imports: [PrismaModule],
  providers: [PackageRefundEligibilityService],
  exports: [PackageRefundEligibilityService],
})
export class PackageRefundsModule {}
