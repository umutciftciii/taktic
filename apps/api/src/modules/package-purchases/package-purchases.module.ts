import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShowcaseLifecycleModule } from '../showcase/showcase-lifecycle.module';
import { PackagePurchasesController } from './package-purchases.controller';
import { PackagePurchasesService } from './package-purchases.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    CreditsModule,
    NumberingModule,
    NotificationsModule,
    // The mock settlement path branches on the purchase's kind exactly as the
    // webhook does, so a vitrin purchase paid through the in-app form produces
    // a placement rather than nothing. Two settlement paths with one branching
    // rule between them would be one deploy away from disagreeing.
    ShowcaseLifecycleModule,
  ],
  controllers: [PackagePurchasesController],
  providers: [PackagePurchasesService],
  exports: [PackagePurchasesService],
})
export class PackagePurchasesModule {}
