import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { PaymentsModule } from '../payments/payments.module';
import { EntitlementRenewalScheduler } from './entitlement-renewal.scheduler';
import { EntitlementRenewalService } from './entitlement-renewal.service';
import { EntitlementResolverService } from './entitlement-resolver.service';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { OfferPackagesService } from './offer-packages.service';

@Module({
  imports: [PrismaModule, AuthModule, CreditsModule, PaymentsModule, OperationsSettingsModule],
  controllers: [EntitlementsController],
  providers: [
    EntitlementResolverService,
    EntitlementsService,
    EntitlementRenewalService,
    EntitlementRenewalScheduler,
    OfferPackagesService,
  ],
  exports: [EntitlementResolverService, EntitlementsService, EntitlementRenewalService],
})
export class EntitlementsModule {}
