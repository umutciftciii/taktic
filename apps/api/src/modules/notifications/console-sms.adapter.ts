import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from './mask';
import { SmsMessage, SmsPort, SmsSendResult } from './sms.port';

/**
 * Development adapter: nothing leaves the process. The one-time code is printed
 * so a developer can finish the flow locally without an SMS provider.
 *
 * In production it prints nothing and fails loudly instead. Two reasons, and
 * both matter: a code in a production log is a credential in a log, and a
 * silent no-op would let phone verification look like it works while no message
 * is ever delivered. Failing is what makes "no SMS provider configured" visible.
 */
@Injectable()
export class ConsoleSmsAdapter extends SmsPort {
  private readonly logger = new Logger('SmsNotification');

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const recipient = maskPhone(message.to);

    if (process.env.NODE_ENV === 'production') {
      this.logger.error(
        `[${message.template}] not delivered to ${recipient}: no SMS transport is configured.`,
      );
      throw new SmsTransportUnavailableError();
    }

    this.logger.log(
      [
        '',
        '──────────── SMS (dev console adapter) ────────────',
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
