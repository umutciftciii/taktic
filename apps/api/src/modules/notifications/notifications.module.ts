import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConsoleNotificationAdapter } from './console-notification.adapter';
import { ConsoleSmsAdapter } from './console-sms.adapter';
import { FileOutboxNotificationAdapter } from './file-outbox-notification.adapter';
import { FileOutboxSmsAdapter } from './file-outbox-sms.adapter';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPort } from './notification.port';
import { isNotificationOutboxEnabled } from './notification-outbox';
import { SmsPort } from './sms.port';

/**
 * The console adapters are the default everywhere. NOTIFICATION_OUTBOX_DIR swaps
 * both transports for the recording ones the browser end-to-end suite reads its
 * one-time codes and claim links from; it cannot be set in production, so this
 * branch is unreachable there. Nothing else about the graph changes — the
 * dispatcher, the audit rows and the masking are the production ones in both
 * cases.
 *
 * Neither branch delivers mail to anybody. That is what
 * `isDeliveringEmailTransportConfigured` reports, and it is why
 * PROVIDER_CLAIM_ENABLED cannot be turned on in production against either.
 */
const useOutbox = isNotificationOutboxEnabled();
const emailAdapter = useOutbox ? FileOutboxNotificationAdapter : ConsoleNotificationAdapter;
const smsAdapter = useOutbox ? FileOutboxSmsAdapter : ConsoleSmsAdapter;

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: NotificationPort, useClass: emailAdapter },
    { provide: SmsPort, useClass: smsAdapter },
    NotificationDispatcher,
  ],
  exports: [NotificationPort, SmsPort, NotificationDispatcher],
})
export class NotificationsModule {}
