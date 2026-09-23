import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConsoleNotificationAdapter } from './console-notification.adapter';
import { ConsoleSmsAdapter } from './console-sms.adapter';
import { FileOutboxNotificationAdapter } from './file-outbox-notification.adapter';
import { FileOutboxSmsAdapter } from './file-outbox-sms.adapter';
import { EmailBrandingService } from './email-branding.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPort } from './notification.port';
import { RequestExpiryOutbox } from './request-expiry-outbox.service';
import { RequestPublishOutbox } from './request-publish-outbox.service';
import { PackageRefundNotificationOutbox } from './package-refund-notification-outbox.service';
import { ReviewInvitationOutbox } from './review-invitation-outbox.service';
import { ShowcaseLifecycleOutbox } from './showcase-lifecycle-outbox.service';
import { isNotificationOutboxEnabled } from './notification-outbox';
import { resolveEmailTransportKind } from './email-transport';
import { ResendNotificationAdapter } from './resend-notification.adapter';
import { SmsPort } from './sms.port';
import { TransactionalMailService } from './transactional-mail.service';

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
    // Reads the admin-managed company settings straight from Prisma rather than
    // through CompanySettingsService: this module is @Global and half the
    // application depends on it, so it must not acquire an edge to a module
    // that imports AuthModule. The rules both sides apply are shared as plain
    // functions instead (company-settings.rules.ts), which is the part that
    // actually has to agree.
    EmailBrandingService,
    NotificationDispatcher,
    TransactionalMailService,
    // The durable half of the request-expiry notice. Provided here, beside the
    // dispatcher and the mail service it is built from, so the request
    // lifecycle module reaches it the way it reaches everything else in this
    // @Global module — without acquiring an edge to it.
    RequestExpiryOutbox,
    // The vitrin run's clock notices, on the same arrangement and for the same
    // reason.
    ShowcaseLifecycleOutbox,
    // The approval fan-out as a durable intent: enqueued inside the publishing
    // transaction by the requests module, swept by the request lifecycle tick.
    RequestPublishOutbox,
    // The review invitation as a durable intent: enqueued inside the completing
    // transaction by the requests module, swept by the same lifecycle tick.
    ReviewInvitationOutbox,
    // CMP-006 PR-B: the package refund status notices, enqueued inside each
    // refund transition, swept by the same lifecycle tick.
    PackageRefundNotificationOutbox,
  ],
  exports: [
    NotificationPort,
    SmsPort,
    EmailBrandingService,
    NotificationDispatcher,
    TransactionalMailService,
    RequestExpiryOutbox,
    ShowcaseLifecycleOutbox,
    RequestPublishOutbox,
    ReviewInvitationOutbox,
    PackageRefundNotificationOutbox,
  ],
})
export class NotificationsModule {}
