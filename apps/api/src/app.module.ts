import { Module } from '@nestjs/common';
import { CategoriesModule } from './modules/categories/categories.module';
import { HealthModule } from './modules/health/health.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { ServiceRequestsModule } from './modules/service-requests/service-requests.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { OffersModule } from './modules/offers/offers.module';
import { CreditsModule } from './modules/credits/credits.module';
import { AuthModule } from './modules/auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    HealthModule,
    PrismaModule,
    AuthModule,
    CategoriesModule,
    QuestionsModule,
    ServiceRequestsModule,
    ProvidersModule,
    OffersModule,
    CreditsModule,
  ],
})
export class AppModule {}
