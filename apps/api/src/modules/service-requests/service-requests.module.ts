import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CategoriesModule } from '../categories/categories.module';
import { CustomerActivationModule } from '../customer-activation/customer-activation.module';
import { NumberingModule } from '../numbering/numbering.module';
import { OffersModule } from '../offers/offers.module';
import { ShowcaseLifecycleModule } from '../showcase/showcase-lifecycle.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  imports: [
    PrismaModule,
    OffersModule,
    AuthModule,
    NumberingModule,
    CustomerActivationModule,
    CategoriesModule,
    // Closing a vitrin lead is part of cancelling or refusing the request it
    // belongs to. The lifecycle module rather than the whole of vitrin: that
    // one creates leads through *this* service, and importing it here would
    // make the pair mutually dependent.
    ShowcaseLifecycleModule,
  ],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
  exports: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
