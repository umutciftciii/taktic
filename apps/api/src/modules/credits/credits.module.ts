import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { PromoCreditLotExpiryService } from './promo-credit-lot-expiry.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [CreditsController],
  // PromoCreditLotExpiryService (CMP-002 S2B1) is an internal seam with no
  // scheduler and no endpoint; it is exported for the S2B2 job that will own it.
  providers: [CreditsService, PromoCreditLotExpiryService],
  exports: [CreditsService, PromoCreditLotExpiryService],
})
export class CreditsModule {}
