import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConsoleNotificationAdapter } from './console-notification.adapter';
import { ConsoleSmsAdapter } from './console-sms.adapter';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPort } from './notification.port';
import { SmsPort } from './sms.port';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: NotificationPort, useClass: ConsoleNotificationAdapter },
    { provide: SmsPort, useClass: ConsoleSmsAdapter },
    NotificationDispatcher,
  ],
  exports: [NotificationPort, SmsPort, NotificationDispatcher],
})
export class NotificationsModule {}
