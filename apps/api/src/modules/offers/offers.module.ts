import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OffersController } from './offers.controller';
import { OffersService } from './offers.service';
import { RefundScanService } from './refund-scan.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OffersController],
  providers: [OffersService, RefundScanService],
  exports: [OffersService, RefundScanService],
})
export class OffersModule {}
