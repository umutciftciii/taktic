import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { maskEmail, maskPhone } from './mask';
import { classifyNotificationError } from './notification-errors';
import { NotificationMessage, NotificationPort } from './notification.port';
import { SmsMessage, SmsPort } from './sms.port';

export type DispatchContext = {
  requestId?: string | null;
  userId?: string | null;
  /**
   * The provider application a message is about. Set on messages that have no
   * account behind them yet — a claim invitation goes out before anybody owns
   * the application, so `userId` cannot carry the link.
   */
  providerId?: string | null;
};

export type DispatchOutcome = {
  logId: string;
  status: NotificationStatus;
  errorCode: string | null;
};

/**
 * Writes the audit row and performs the send.
 *
 * Two rules shape this service:
 *
 * 1. It never throws. A transport failure must not roll back the business
 *    transaction that asked for the message — an issued verification code is
 *    still valid even if the SMS never left the building. The caller reads the
 *    returned status instead.
 * 2. The audit row is written *before* the send, so a crash mid-send still
 *    leaves a PENDING trace rather than no trace at all.
 *
 * Nothing that could be replayed is stored: no code, token, action URL or
 * message body, and the recipient only ever appears masked.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger('NotificationDispatcher');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationPort) private readonly email: NotificationPort,
    @Inject(SmsPort) private readonly sms: SmsPort,
  ) {}

  async sendEmail(message: NotificationMessage, context: DispatchContext = {}) {
    return this.dispatch(
      NotificationChannel.EMAIL,
      message.template,
      maskEmail(message.to),
      context,
      () => this.email.send(message),
    );
  }

  async sendSms(message: SmsMessage, context: DispatchContext = {}) {
    return this.dispatch(
      NotificationChannel.SMS,
      message.template,
      maskPhone(message.to),
      context,
      () => this.sms.send(message),
    );
  }

  private async dispatch(
    channel: NotificationChannel,
    template: string,
    maskedRecipient: string,
    context: DispatchContext,
    send: () => Promise<{ providerMessageId: string | null }>,
  ): Promise<DispatchOutcome> {
    const log = await this.prisma.notificationLog.create({
      data: {
        channel,
        template,
        maskedRecipient,
        status: NotificationStatus.PENDING,
        requestId: context.requestId ?? null,
        userId: context.userId ?? null,
        providerId: context.providerId ?? null,
      },
      select: { id: true },
    });

    try {
      const result = await send();
      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
        },
      });

      return { logId: log.id, status: NotificationStatus.SENT, errorCode: null };
    } catch (error) {
      const errorCode = classifyNotificationError(error);
      // Only the class is recorded and logged. A provider error string can
      // contain the destination address or the message body.
      this.logger.warn(`${template} via ${channel} failed for ${maskedRecipient}: ${errorCode}`);

      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: NotificationStatus.FAILED,
          failedAt: new Date(),
          errorCode,
        },
      });

      return { logId: log.id, status: NotificationStatus.FAILED, errorCode };
    }
  }
}
