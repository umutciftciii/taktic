import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { OffersController } from './offers.controller';
import { OffersService } from './offers.service';
import { UnviewedOfferRefundService } from './unviewed-offer-refund.service';

@Module({
  imports: [PrismaModule, AuthModule, OperationsSettingsModule],
  controllers: [OffersController],
  providers: [OffersService, UnviewedOfferRefundService],
  exports: [OffersService, UnviewedOfferRefundService],
})
export class OffersModule {}
