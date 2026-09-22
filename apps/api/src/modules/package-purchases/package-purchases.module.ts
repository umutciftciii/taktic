import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignEngineModule } from '../campaigns/engine/campaign-engine.module';
import { CreditsModule } from '../credits/credits.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PurchaseTermsModule } from '../purchase-terms/purchase-terms.module';
import { ShowcaseLifecycleModule } from '../showcase/showcase-lifecycle.module';
import { PackagePurchasesController } from './package-purchases.controller';
import { PackagePurchasesService } from './package-purchases.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    CreditsModule,
    NumberingModule,
    NotificationsModule,
    // The mock settlement path branches on the purchase's kind exactly as the
    // webhook does, so a vitrin purchase paid through the in-app form produces
    // a placement rather than nothing. Two settlement paths with one branching
    // rule between them would be one deploy away from disagreeing.
    ShowcaseLifecycleModule,
    // The mock settlement raises the PACKAGE_PAYMENT_SUCCEEDED campaign event
    // exactly where the webhook does (CMP-002 S2B2). Prisma-only, no cycle.
    CampaignEngineModule,
    // CMP-006 PR-A: a credit-package purchase opened while the purchase-terms
    // gate is open carries its acceptance, written in the same transaction.
    PurchaseTermsModule,
  ],
  controllers: [PackagePurchasesController],
  providers: [PackagePurchasesService],
  exports: [PackagePurchasesService],
})
export class PackagePurchasesModule {}
