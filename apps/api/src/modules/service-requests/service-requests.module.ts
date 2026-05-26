import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { OffersModule } from '../offers/offers.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  imports: [PrismaModule, OffersModule],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
