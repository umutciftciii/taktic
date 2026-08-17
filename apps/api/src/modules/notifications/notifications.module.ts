import { Global, Module } from '@nestjs/common';
import { ConsoleNotificationAdapter } from './console-notification.adapter';
import { NotificationPort } from './notification.port';

@Global()
@Module({
  providers: [{ provide: NotificationPort, useClass: ConsoleNotificationAdapter }],
  exports: [NotificationPort],
})
export class NotificationsModule {}
