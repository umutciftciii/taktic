import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CategoriesModule } from './modules/categories/categories.module';
import { CustomersModule } from './modules/customers/customers.module';
import { HealthModule } from './modules/health/health.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { ServiceRequestsModule } from './modules/service-requests/service-requests.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { OffersModule } from './modules/offers/offers.module';
import { RefundSchedulerModule } from './modules/refund-scheduler/refund-scheduler.module';
import { CreditsModule } from './modules/credits/credits.module';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FinanceModule } from './modules/finance/finance.module';
import { PackagePurchasesModule } from './modules/package-purchases/package-purchases.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { NumberingModule } from './modules/numbering/numbering.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    HealthModule,
    PrismaModule,
    AuthModule,
    CategoriesModule,
    QuestionsModule,
    ServiceRequestsModule,
    ProvidersModule,
    OffersModule,
    RefundSchedulerModule,
    CreditsModule,
    CustomersModule,
    DashboardModule,
    FinanceModule,
    PackagePurchasesModule,
    UploadsModule,
    NumberingModule,
  ],
})
export class AppModule {}
