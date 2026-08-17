import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RequestExpiryService } from './request-expiry.service';
import { RequestLifecycleSchedulerService } from './request-lifecycle-scheduler.service';
import { RequestReminderService } from './request-reminder.service';

@Module({
  imports: [PrismaModule],
  providers: [RequestExpiryService, RequestReminderService, RequestLifecycleSchedulerService],
  exports: [RequestExpiryService, RequestReminderService],
})
export class RequestLifecycleModule {}
