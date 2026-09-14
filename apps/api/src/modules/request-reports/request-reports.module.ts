import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { AdminRequestReportsController } from './admin-request-reports.controller';
import { ProviderRequestReportsController } from './provider-request-reports.controller';
import { RequestReportsService } from './request-reports.service';

/**
 * `ServiceRequestsModule` is imported for the removal cascade and the reopen
 * path; it does not import this module back, so there is no cycle. The mail
 * service comes from the global `NotificationsModule`.
 *
 * Registered before `ServiceRequestsModule` in `AppModule` on purpose — see
 * `AdminRequestReportsController` for the route-order reason.
 */
@Module({
  imports: [PrismaModule, AuthModule, ProvidersModule, ServiceRequestsModule],
  controllers: [ProviderRequestReportsController, AdminRequestReportsController],
  providers: [RequestReportsService],
  exports: [RequestReportsService],
})
export class RequestReportsModule {}
