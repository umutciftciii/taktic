import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CustomerActivationModule } from '../customer-activation/customer-activation.module';
import { NumberingModule } from '../numbering/numbering.module';
import { OffersModule } from '../offers/offers.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  imports: [PrismaModule, OffersModule, AuthModule, NumberingModule, CustomerActivationModule],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
