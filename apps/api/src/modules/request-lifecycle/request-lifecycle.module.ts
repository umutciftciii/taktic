import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { RequestExpiryService } from './request-expiry.service';
import { RequestLifecycleSchedulerService } from './request-lifecycle-scheduler.service';
import { RequestReminderService } from './request-reminder.service';

/**
 * NotificationsModule is not imported: it is @Global, so the expiry service
 * reaches TransactionalMailService without this module acquiring an edge to it.
 */
@Module({
  imports: [PrismaModule, OperationsSettingsModule],
  providers: [RequestExpiryService, RequestReminderService, RequestLifecycleSchedulerService],
  exports: [RequestExpiryService, RequestReminderService],
})
export class RequestLifecycleModule {}
