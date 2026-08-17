import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConsoleNotificationAdapter } from './console-notification.adapter';
import { ConsoleSmsAdapter } from './console-sms.adapter';
import { FileOutboxSmsAdapter } from './file-outbox-sms.adapter';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPort } from './notification.port';
import { isNotificationOutboxEnabled } from './notification-outbox';
import { SmsPort } from './sms.port';

/**
 * The console adapter is the default everywhere. NOTIFICATION_OUTBOX_DIR swaps
 * the SMS transport for the recording one the browser end-to-end suite reads
 * its one-time codes from; it cannot be set in production, so this branch is
 * unreachable there. Nothing else about the graph changes — the dispatcher, the
 * audit rows and the masking are the production ones in both cases.
 */
const smsAdapter = isNotificationOutboxEnabled() ? FileOutboxSmsAdapter : ConsoleSmsAdapter;

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: NotificationPort, useClass: ConsoleNotificationAdapter },
    { provide: SmsPort, useClass: smsAdapter },
    NotificationDispatcher,
  ],
  exports: [NotificationPort, SmsPort, NotificationDispatcher],
})
export class NotificationsModule {}
