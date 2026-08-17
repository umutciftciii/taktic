import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskPhone } from './mask';
import { notificationOutboxDir } from './notification-outbox';
import { SmsMessage, SmsPort, SmsSendResult } from './sms.port';

const OUTBOX_FILE = 'sms.jsonl';

export type SmsOutboxEntry = {
  template: string;
  to: string;
  code: string;
  expiresInMinutes: number;
  providerMessageId: string;
  sentAt: string;
};

/**
 * Test transport: the message is appended to a JSON-lines file instead of being
 * delivered, so an out-of-process test can read what the application sent.
 *
 * It reports success like a real provider would, which matters: the phone
 * verification flow must be exercised on its happy path, not on the
 * "transport unavailable" branch the console adapter produces outside
 * development.
 *
 * Writes are synchronous appends. A one-line append is atomic enough for the
 * single reader that polls this file, and it means the entry is on disk before
 * the HTTP response that triggered it returns — so a test that waits for the
 * page to settle can never race the code it is about to type.
 *
 * Enabled only via NOTIFICATION_OUTBOX_DIR, which cannot be set in production.
 */
@Injectable()
export class FileOutboxSmsAdapter extends SmsPort {
  private readonly logger = new Logger('SmsOutbox');

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const dir = notificationOutboxDir();
    if (!dir) {
      throw new Error('The SMS outbox transport was used without NOTIFICATION_OUTBOX_DIR.');
    }

    const providerMessageId = `outbox-${randomUUID()}`;
    const entry: SmsOutboxEntry = {
      template: message.template,
      to: message.to,
      code: message.code,
      expiresInMinutes: message.expiresInMinutes,
      providerMessageId,
      sentAt: new Date().toISOString(),
    };

    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, OUTBOX_FILE), `${JSON.stringify(entry)}\n`, 'utf8');

    // The log line stays as poor in detail as the production one: the file is
    // the test channel, the log is not.
    this.logger.log(`[${message.template}] recorded for ${maskPhone(message.to)}`);

    return { providerMessageId };
  }
}
