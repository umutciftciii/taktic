import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AccountModule } from './modules/account/account.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CompanySettingsModule } from './modules/company-settings/company-settings.module';
import { ContactSharingModule } from './modules/contact-sharing/contact-sharing.module';
import { CustomerActivationModule } from './modules/customer-activation/customer-activation.module';
import { CustomersModule } from './modules/customers/customers.module';
import { EmailVerificationModule } from './modules/email-verification/email-verification.module';
import { EntitlementsModule } from './modules/entitlements/entitlements.module';
import { HealthModule } from './modules/health/health.module';
import { LocationsModule } from './modules/locations/locations.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { ServiceRequestsModule } from './modules/service-requests/service-requests.module';
import { ShowcaseModule } from './modules/showcase/showcase.module';
import { SitemapModule } from './modules/sitemap/sitemap.module';
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module';
import { ProviderClaimModule } from './modules/provider-claim/provider-claim.module';
import { ProviderInvitesModule } from './modules/provider-invites/provider-invites.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { BusinessRegistrationModule } from './modules/business-registration/business-registration.module';
import { ProviderReviewsModule } from './modules/provider-reviews/provider-reviews.module';
import { RequestReportsModule } from './modules/request-reports/request-reports.module';
import { OffersModule } from './modules/offers/offers.module';
import { OperationsSettingsModule } from './modules/operations-settings/operations-settings.module';
import { PhoneVerificationModule } from './modules/phone-verification/phone-verification.module';
import { UnviewedOfferRefundModule } from './modules/unviewed-offer-refund/unviewed-offer-refund.module';
import { RequestDraftsModule } from './modules/request-drafts/request-drafts.module';
import { RequestLifecycleModule } from './modules/request-lifecycle/request-lifecycle.module';
import { CreditsModule } from './modules/credits/credits.module';
import { AuthModule } from './modules/auth/auth.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FinanceModule } from './modules/finance/finance.module';
import { PackagePurchasesModule } from './modules/package-purchases/package-purchases.module';
import { PackageRefundsModule } from './modules/package-refunds/package-refunds.module';
import { PasswordResetModule } from './modules/password-reset/password-reset.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { NotificationLogsModule } from './modules/notification-logs/notification-logs.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NumberingModule } from './modules/numbering/numbering.module';
import { AdminRolesModule } from './modules/admin-roles/admin-roles.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { TurnstileModule } from './modules/turnstile/turnstile.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    HealthModule,
    PrismaModule,
    TurnstileModule,
    CampaignsModule,
    NotificationsModule,
    AuthModule,
    AccountModule,
    EmailVerificationModule,
    PasswordResetModule,
    CategoriesModule,
    LocationsModule,
    QuestionsModule,
    RequestDraftsModule,
    // Before ServiceRequestsModule, and not by accident: its admin controller
    // serves `GET /service-requests/reports`, which ServiceRequestsController's
    // `GET :id` would capture if its routes were registered first. Nest
    // registers routes in module insertion order, which is this list's order
    // (depth-first), and request-reports-admin.spec.ts asserts a 200 on that
    // path so a reordering here fails loudly.
    RequestReportsModule,
    ServiceRequestsModule,
    ProviderClaimModule,
    // Before ProvidersModule: `GET /providers/me/business-registration` must not
    // be read as anything of ProvidersController's.
    BusinessRegistrationModule,
    ProvidersModule,
    ProviderReviewsModule,
    ProviderInvitesModule,
    OffersModule,
    PhoneVerificationModule,
    UnviewedOfferRefundModule,
    RequestLifecycleModule,
    CreditsModule,
    EntitlementsModule,
    CustomersModule,
    CustomerActivationModule,
    DashboardModule,
    FinanceModule,
    PackagePurchasesModule,
    PackageRefundsModule,
    PaymentsModule,
    UploadsModule,
    ContactSharingModule,
    MessagingModule,
    ShowcaseModule,
    SupportTicketsModule,
    CompanySettingsModule,
    OperationsSettingsModule,
    NotificationLogsModule,
    SitemapModule,
    NumberingModule,
    UsersModule,
    AdminRolesModule,
  ],
})
export class AppModule {}
