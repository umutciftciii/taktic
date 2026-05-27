import { Module } from '@nestjs/common';
import { OffersModule } from '../offers/offers.module';
import { RefundSchedulerService } from './refund-scheduler.service';

@Module({
  imports: [OffersModule],
  providers: [RefundSchedulerService],
})
export class RefundSchedulerModule {}
