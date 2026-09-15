import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { ProviderReviewsModule } from '../provider-reviews/provider-reviews.module';
import { OffersController } from './offers.controller';
import { OffersService } from './offers.service';
import { UnviewedOfferRefundService } from './unviewed-offer-refund.service';

@Module({
  // ProviderReviewsModule imports only PrismaModule and AuthModule, so the
  // customer's offer cards can carry a provider's public rating without the
  // two modules depending on each other.
  imports: [PrismaModule, AuthModule, OperationsSettingsModule, ProviderReviewsModule],
  controllers: [OffersController],
  providers: [OffersService, UnviewedOfferRefundService],
  exports: [OffersService, UnviewedOfferRefundService],
})
export class OffersModule {}
