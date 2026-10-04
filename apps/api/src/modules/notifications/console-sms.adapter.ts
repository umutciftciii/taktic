import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from './mask';
import { SmsMessage, SmsPort, SmsSendResult } from './sms.port';
import { isConsoleSmsPermitted } from './sms-transport';

/**
 * Stand-in adapter: nothing leaves the process. The one-time code is printed
 * to this process's log so a developer — or, on staging, the host operator
 * through `docker logs` — can finish the flow without an SMS provider. It is
 * never returned to a caller or stored.
 *
 * On a production deployment (APP_ENVIRONMENT=production, or a local or
 * undeclared stack under NODE_ENV=production; see sms-transport.ts) it prints
 * nothing and fails loudly instead. Two reasons, and both matter: a code in a
 * production log is a credential in a log, and a silent no-op would let phone
 * verification look like it works while no message is ever delivered. Failing
 * is what makes "no SMS provider configured" visible.
 */
@Injectable()
export class ConsoleSmsAdapter extends SmsPort {
  private readonly logger = new Logger('SmsNotification');

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const recipient = maskPhone(message.to);

    if (!isConsoleSmsPermitted()) {
      this.logger.error(
        `[${message.template}] not delivered to ${recipient}: no SMS transport is configured.`,
      );
      throw new SmsTransportUnavailableError();
    }

    this.logger.log(
      [
        '',
        '──────────── SMS (console adapter, not delivered) ─',
        `template : ${message.template}`,
        `to       : ${message.to}`,
        `code     : ${message.code}`,
        `expires  : ${message.expiresInMinutes} dk`,
        '───────────────────────────────────────────────────',
      ].join('\n'),
    );

    return { providerMessageId: null };
  }
}

/** Thrown when no real transport is wired; carries no recipient or code. */
export class SmsTransportUnavailableError extends Error {
  readonly errorCode = 'TRANSPORT_UNAVAILABLE';

  constructor() {
    super('No SMS transport is configured');
    this.name = 'SmsTransportUnavailableError';
  }
}
