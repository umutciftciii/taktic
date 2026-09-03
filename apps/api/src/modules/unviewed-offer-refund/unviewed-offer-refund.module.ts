import { Module } from '@nestjs/common';
import { OffersModule } from '../offers/offers.module';
import { UnviewedOfferRefundSchedulerService } from './unviewed-offer-refund.scheduler';

@Module({
  imports: [OffersModule],
  providers: [UnviewedOfferRefundSchedulerService],
})
export class UnviewedOfferRefundModule {}
