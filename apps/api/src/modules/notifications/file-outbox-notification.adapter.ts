import { Injectable, Logger } from '@nestjs/common';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskEmail } from './mask';
import { notificationOutboxDir } from './notification-outbox';
import {
  NotificationMessage,
  NotificationPort,
  NotificationSendResult,
} from './notification.port';

const OUTBOX_FILE = 'email.jsonl';

/**
 * What the browser suite is allowed to read back.
 *
 * Deliberately not `NotificationMessage`: the subject line and the free-form
 * `data` bag are message content, and a test has no business reading them. What
 * a test genuinely cannot obtain any other way is the action URL — it carries a
 * single-use token that is never returned over HTTP and never stored in
 * plaintext — plus enough addressing to pick the right entry out of the file.
 */
export type EmailOutboxEntry = {
  template: string;
  to: string;
  actionUrl: string | null;
  sentAt: string;
};

/**
 * Test transport: the message is appended to a JSON-lines file instead of being
 * delivered, so an out-of-process test can follow the link the application
 * decided to send.
 *
 * This is the e-mail twin of {@link import('./file-outbox-sms.adapter')} and it
 * exists for the same reason: the claim URL is deliberately never returned over
 * HTTP, so a browser driving the real screens has no other way to reach it.
 * Scraping stdout would tie the suite to a log format and race the process's own
 * buffering; the console adapter also refuses to print the URL outside
 * development, which would make the flag-on runtime untestable.
 *
 * Writes are synchronous appends, so the entry is on disk before the HTTP
 * response that triggered it returns — a test that waits for the page to settle
 * can never race the link it is about to open.
 *
 * Enabled only via NOTIFICATION_OUTBOX_DIR, which cannot be set in production
 * (see notification-outbox.ts). Independently of that, a delivering transport is
 * what PROVIDER_CLAIM_ENABLED requires in production, and this is not one — so
 * it can never become the transport a live claim flow relies on.
 */
@Injectable()
export class FileOutboxNotificationAdapter extends NotificationPort {
  private readonly logger = new Logger('NotificationOutbox');

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    const dir = notificationOutboxDir();
    if (!dir) {
      throw new Error('The e-mail outbox transport was used without NOTIFICATION_OUTBOX_DIR.');
    }

    const entry: EmailOutboxEntry = {
      template: message.template,
      to: message.to,
      actionUrl: message.actionUrl ?? null,
      sentAt: new Date().toISOString(),
    };

    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, OUTBOX_FILE), `${JSON.stringify(entry)}\n`, 'utf8');

    // The log line stays as poor in detail as the production one: the file is
    // the test channel, the log is not.
    this.logger.log(`[${message.template}] recorded for ${maskEmail(message.to)}`);

    // Deliberately no provider id: nothing was delivered, and the audit row for
    // a recorded message must not look like one a provider accepted.
    return { providerMessageId: null };
  }
}
