import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
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

/**
 * The context {@link NotificationDispatcher.sendEmailOnce} takes.
 *
 * `dedupeKey` names the state transition this message belongs to, as a short
 * opaque string built from ids and timestamps — "offer-accepted:<offerId>". The
 * audit row carries it, the database holds a unique index on
 * (template, dedupeKey), and a second attempt for the same transition is
 * refused before anything is sent. That is what stops a retried request, a
 * re-run fan-out or a double-clicked admin action from mailing the same person
 * twice.
 *
 * Messages that are *meant* to repeat — a fresh verification link the recipient
 * asked for again — go through the plain `sendEmail` instead.
 */
export type DedupedDispatchContext = DispatchContext & { dedupeKey: string };

export type DispatchOutcome = {
  logId: string;
  status: NotificationStatus;
  errorCode: string | null;
};

/**
 * What a de-duplicated send reports.
 *
 * `DUPLICATE` is not a failure: it means this exact state transition had
 * already produced a message, so nothing was sent and nothing needed to be. A
 * caller counting deliveries must distinguish it from SENT; a caller deciding
 * whether to warn an operator must not. No row is written for it, so there is
 * no log id to hand back.
 */
export type DedupedDispatchOutcome =
  | DispatchOutcome
  | { logId: null; status: 'DUPLICATE'; errorCode: null };

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
 *
 * There is deliberately no *automatic* re-send. A FAILED row stays visible in
 * NotificationLog and the transition is not re-opened, which is the same choice
 * the request reminder makes and for the same reason: re-mailing on every pass
 * while a transport is broken turns one undelivered message into a flood.
 *
 * What does exist is {@link NotificationDispatcher.resendExistingEmail}: one
 * deliberate admin action, against one existing row, re-sent under that row's
 * own idempotency key. It creates no notification identity of its own — no new
 * log row, no new dedupeKey — so "one message per real transition" survives it,
 * and a timeout that actually delivered is de-duplicated by the provider rather
 * than delivered twice.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger('NotificationDispatcher');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationPort) private readonly email: NotificationPort,
    @Inject(SmsPort) private readonly sms: SmsPort,
  ) {}

  async sendEmail(
    message: NotificationMessage,
    context: DispatchContext = {},
  ): Promise<DispatchOutcome> {
    const outcome = await this.dispatch(
      NotificationChannel.EMAIL,
      message.template,
      maskEmail(message.to),
      context,
      null,
      (logId) => this.email.send({ ...message, idempotencyKey: notificationIdempotencyKey(logId) }),
    );

    // Unreachable without a dedupe key, and narrowed rather than cast so it
    // stays unreachable if the branch above ever changes.
    if (outcome.status === 'DUPLICATE') {
      throw new Error('A send without a dedupe key cannot be a duplicate.');
    }

    return outcome;
  }

  /**
   * Sends at most one message per state transition. See
   * {@link DedupedDispatchContext}.
   */
  sendEmailOnce(
    message: NotificationMessage,
    context: DedupedDispatchContext,
  ): Promise<DedupedDispatchOutcome> {
    return this.dispatch(
      NotificationChannel.EMAIL,
      message.template,
      maskEmail(message.to),
      context,
      context.dedupeKey,
      (logId) => this.email.send({ ...message, idempotencyKey: notificationIdempotencyKey(logId) }),
    );
  }

  async sendSms(message: SmsMessage, context: DispatchContext = {}): Promise<DispatchOutcome> {
    const outcome = await this.dispatch(
      NotificationChannel.SMS,
      message.template,
      maskPhone(message.to),
      context,
      null,
      // No SMS provider is wired yet, and none of the stand-ins de-duplicate,
      // so nothing is derived here rather than passing a key nobody reads.
      () => this.sms.send(message),
    );

    if (outcome.status === 'DUPLICATE') {
      throw new Error('A send without a dedupe key cannot be a duplicate.');
    }

    return outcome;
  }

  private async dispatch(
    channel: NotificationChannel,
    template: string,
    maskedRecipient: string,
    context: DispatchContext,
    dedupeKey: string | null,
    send: (logId: string) => Promise<{ providerMessageId: string | null }>,
  ): Promise<DedupedDispatchOutcome> {
    let log: { id: string };

    try {
      log = await this.prisma.notificationLog.create({
        data: {
          channel,
          template,
          maskedRecipient,
          status: NotificationStatus.PENDING,
          requestId: context.requestId ?? null,
          userId: context.userId ?? null,
          providerId: context.providerId ?? null,
          dedupeKey,
          lastAttemptAt: new Date(),
        },
        select: { id: true },
      });
    } catch (error) {
      // The unique index on (template, dedupeKey) rejected the row, so this
      // transition has already produced a message. Nothing is sent: the whole
      // point of the key is that the database, not the caller's bookkeeping,
      // decides whether a second attempt is a duplicate.
      if (dedupeKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { logId: null, status: 'DUPLICATE', errorCode: null };
      }

      throw error;
    }

    return this.attempt(log.id, channel, template, maskedRecipient, send);
  }

  /**
   * Re-sends an existing audit row, without creating a second one.
   *
   * The caller owns the transition into this method: it has already moved the
   * row out of FAILED in a single conditional update, so exactly one caller can
   * be here for a given row at a time and no new notification identity — no new
   * id, no new dedupeKey — comes into existence. This method only performs the
   * send and records its outcome on the row it was given.
   *
   * The idempotency key is derived from that row's id, so the retry is offered
   * to the provider under the same name the first attempt used.
   */
  resendExistingEmail(
    logId: string,
    message: NotificationMessage,
    maskedRecipient: string,
  ): Promise<DispatchOutcome> {
    return this.attempt(logId, NotificationChannel.EMAIL, message.template, maskedRecipient, (id) =>
      this.email.send({ ...message, idempotencyKey: notificationIdempotencyKey(id) }),
    );
  }

  /**
   * Records the outcome of one attempt against a row that already exists.
   *
   * `lastAttemptAt` is not touched here: it marks when the attempt was claimed,
   * which both callers do before reaching this point, and overwriting it with
   * the completion time would lose the only timestamp a row stuck in PENDING
   * carries.
   */
  private async attempt(
    logId: string,
    channel: NotificationChannel,
    template: string,
    maskedRecipient: string,
    send: (logId: string) => Promise<{ providerMessageId: string | null }>,
  ): Promise<DispatchOutcome> {
    try {
      const result = await send(logId);
      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
          // Cleared on success so a row that failed and was later re-sent does
          // not keep advertising a defect that is no longer true.
          errorCode: null,
        },
      });

      return { logId, status: NotificationStatus.SENT, errorCode: null };
    } catch (error) {
      const errorCode = classifyNotificationError(error);
      // Only the class is recorded and logged. A provider error string can
      // contain the destination address or the message body.
      this.logger.warn(`${template} via ${channel} failed for ${maskedRecipient}: ${errorCode}`);

      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: NotificationStatus.FAILED,
          failedAt: new Date(),
          errorCode,
        },
      });

      return { logId, status: NotificationStatus.FAILED, errorCode };
    }
  }
}

/**
 * The transport-facing name of one audit row.
 *
 * Derived from the row id alone, so it is stable across the first dispatch and
 * every later retry of the same row — see NotificationMessage.idempotencyKey.
 * The prefix keeps it recognisable in a provider's dashboard without saying
 * anything about the message.
 */
export function notificationIdempotencyKey(logId: string): string {
  return `taktic-notification-${logId}`;
}
