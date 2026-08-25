import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConsoleNotificationAdapter } from './console-notification.adapter';
import { ConsoleSmsAdapter } from './console-sms.adapter';
import { FileOutboxNotificationAdapter } from './file-outbox-notification.adapter';
import { FileOutboxSmsAdapter } from './file-outbox-sms.adapter';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPort } from './notification.port';
import { isNotificationOutboxEnabled } from './notification-outbox';
import { resolveEmailTransportKind } from './email-transport';
import { ResendNotificationAdapter } from './resend-notification.adapter';
import { SmsPort } from './sms.port';

/**
 * Which e-mail adapter is bound is decided by EMAIL_TRANSPORT, through the same
 * allow-list every boot check reads (see email-transport.ts). The console
 * adapter stays the default: a developer who configures nothing gets a process
 * that delivers nothing, and only an explicit EMAIL_TRANSPORT=resend puts mail
 * in a stranger's inbox.
 *
 * NOTIFICATION_OUTBOX_DIR selects the recording transports the browser
 * end-to-end suite reads its one-time codes and claim links from; it cannot be
 * set in production. SMS has no provider yet, so it still follows that switch
 * alone.
 *
 * Nothing else about the graph changes in any branch — the dispatcher, the
 * audit rows and the masking are the production ones throughout.
 */
const emailTransport = resolveEmailTransportKind();
const emailAdapter =
  emailTransport === 'resend'
    ? ResendNotificationAdapter
    : emailTransport === 'file-outbox'
      ? FileOutboxNotificationAdapter
      : ConsoleNotificationAdapter;
const smsAdapter = isNotificationOutboxEnabled() ? FileOutboxSmsAdapter : ConsoleSmsAdapter;

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
