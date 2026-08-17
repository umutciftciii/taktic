import { Injectable, Logger } from '@nestjs/common';
import { NotificationMessage, NotificationPort } from './notification.port';

/**
 * Development adapter: nothing leaves the process, the message is written to the
 * application log so a developer can complete the flow locally.
 *
 * The action URL embeds a single-use activation token, so it is only printed
 * outside production. In production this adapter refuses to print it and warns
 * that no real transport is configured — that is the signal to wire a provider.
 */
@Injectable()
export class ConsoleNotificationAdapter extends NotificationPort {
  private readonly logger = new Logger('Notification');

  async send(message: NotificationMessage): Promise<void> {
    const recipient = maskEmail(message.to);

    if (process.env.NODE_ENV === 'production') {
      this.logger.warn(
        `[${message.template}] not delivered to ${recipient}: no notification transport is configured.`,
      );
      return;
    }

    const lines = [
      '',
      '──────────── NOTIFICATION (dev console adapter) ────────────',
      `template : ${message.template}`,
      `to       : ${message.to}`,
      `subject  : ${message.subject}`,
    ];

    for (const [key, value] of Object.entries(message.data ?? {})) {
      if (value) {
        lines.push(`${key.padEnd(9)}: ${value}`);
      }
    }

    if (message.actionUrl) {
      lines.push(`url      : ${message.actionUrl}`);
    }

    lines.push('────────────────────────────────────────────────────────────');

    this.logger.log(lines.join('\n'));
  }
}

function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!local || !domain) {
    return '***';
  }

  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
