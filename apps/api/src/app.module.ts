import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CategoriesModule } from './modules/categories/categories.module';
import { CompanySettingsModule } from './modules/company-settings/company-settings.module';
import { ContactSharingModule } from './modules/contact-sharing/contact-sharing.module';
import { CustomerActivationModule } from './modules/customer-activation/customer-activation.module';
import { CustomersModule } from './modules/customers/customers.module';
import { EmailVerificationModule } from './modules/email-verification/email-verification.module';
import { HealthModule } from './modules/health/health.module';
import { LocationsModule } from './modules/locations/locations.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { ServiceRequestsModule } from './modules/service-requests/service-requests.module';
import { ProviderClaimModule } from './modules/provider-claim/provider-claim.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { OffersModule } from './modules/offers/offers.module';
import { PhoneVerificationModule } from './modules/phone-verification/phone-verification.module';
import { RefundSchedulerModule } from './modules/refund-scheduler/refund-scheduler.module';
import { RequestLifecycleModule } from './modules/request-lifecycle/request-lifecycle.module';
import { CreditsModule } from './modules/credits/credits.module';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FinanceModule } from './modules/finance/finance.module';
import { PackagePurchasesModule } from './modules/package-purchases/package-purchases.module';
import { PasswordResetModule } from './modules/password-reset/password-reset.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { NotificationLogsModule } from './modules/notification-logs/notification-logs.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NumberingModule } from './modules/numbering/numbering.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    HealthModule,
    PrismaModule,
    NotificationsModule,
    AuthModule,
    EmailVerificationModule,
    PasswordResetModule,
    CategoriesModule,
    LocationsModule,
    QuestionsModule,
    ServiceRequestsModule,
    ProviderClaimModule,
    ProvidersModule,
    OffersModule,
    PhoneVerificationModule,
    RefundSchedulerModule,
    RequestLifecycleModule,
    CreditsModule,
    CustomersModule,
    CustomerActivationModule,
    DashboardModule,
    FinanceModule,
    PackagePurchasesModule,
    PaymentsModule,
    UploadsModule,
    ContactSharingModule,
    CompanySettingsModule,
    NotificationLogsModule,
    NumberingModule,
    UsersModule,
  ],
})
export class AppModule {}
