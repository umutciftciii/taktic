import { Module } from '@nestjs/common';
import { OffersModule } from '../offers/offers.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { UnviewedOfferRefundSchedulerService } from './unviewed-offer-refund.scheduler';

@Module({
  imports: [OffersModule, OperationsSettingsModule],
  providers: [UnviewedOfferRefundSchedulerService],
})
export class UnviewedOfferRefundModule {}
