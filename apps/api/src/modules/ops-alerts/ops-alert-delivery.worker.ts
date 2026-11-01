import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OpsAlertChannel, OpsAlertDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyNotificationError } from '../notifications/notification-errors';
import { NotificationPort } from '../notifications/notification.port';
import { transactionalSubject } from '../notifications/templates/transactional-templates';
import { getAdminAppBaseUrl } from '../users/admin-invite.constants';
import { readOpsAlertConfigSafely } from './ops-alert.config';
import {
  DELIVERY_BATCH,
  DELIVERY_LEASE_MS,
  DELIVERY_MAX_ATTEMPTS,
  composeNotice,
  readNoticeSnapshot,
  deliveryBackoffMs,
  systemHealthUrl,
} from './ops-alert.rules';
import { TelegramAlertPort, TelegramSendError } from './telegram-alert.port';

/** The idempotency key an alert e-mail carries: the delivery row, nothing else. */
export function opsAlertIdempotencyKey(deliveryId: string): string {
  return `taktic-ops-alert-${deliveryId}`;
}

export type DeliveryPassOutcome = { claimed: number; sent: number; failed: number; abandoned: number };

/**
 * OBS-ALERT-001 — sends what the evaluator queued, one delivery at a time.
 *
 * **The claim.** One statement moves due rows to SENDING under a fresh token:
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. Two workers — two
 * instances, or a tick overlapping a slow one — lock disjoint rows, so a
 * delivery is held by one worker at a time. The outcome is written only
 * `WHERE claimToken = <mine>`: a worker whose lease ran out (it hung past
 * {@link DELIVERY_LEASE_MS}) cannot overwrite the result of the worker that
 * took the row over.
 *
 * **Duplicates.** The one case a retry can repeat a message is a send that
 * reached the provider but did not come back (a timeout). E-mail is offered
 * again under the same idempotency key — the delivery's id — and Resend
 * answers with the original message instead of a second one. Telegram has no
 * such key: a repeat after a timeout can reach the chat twice. Every message
 * carries the alert's fixed event id ("OPS-…"), so a duplicate reads as the
 * same event, not as a new one.
 *
 * **Isolation.** The two channels are separate rows with separate retries; a
 * channel that is down is retried with backoff and then abandoned, and
 * nothing it does touches the other channel, a NotificationLog row, a
 * SchedulerRun row or an alert. A failed alert delivery never becomes an
 * alert: the evaluator does not read this table.
 *
 * Nothing here logs a recipient, a chat id, a token or a provider's text —
 * the event id, the notice, the channel and a closed code.
 */
@Injectable()
export class OpsAlertDeliveryWorker {
  private readonly logger = new Logger('OpsAlertDelivery');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationPort) private readonly email: NotificationPort,
    @Inject(TelegramAlertPort) private readonly telegram: TelegramAlertPort,
  ) {}

  async deliverDue(): Promise<DeliveryPassOutcome> {
    const outcome: DeliveryPassOutcome = { claimed: 0, sent: 0, failed: 0, abandoned: 0 };
    outcome.abandoned += await this.abandonExpiredClaims();

    const token = randomUUID();
    const claimed = await this.claim(token);
    outcome.claimed = claimed.length;
    for (const id of claimed) {
      const result = await this.deliverOne(id, token);
      outcome[result] += 1;
    }
    return outcome;
  }

  /**
   * Takes up to {@link DELIVERY_BATCH} due rows: PENDING or FAILED whose next
   * attempt is due, and SENDING whose lease ran out with attempts left. The
   * database clock decides "due", like the scheduler lease does.
   */
  async claim(token: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "OpsAlertDelivery"
      SET "status" = 'SENDING',
          "claimToken" = ${token},
          "claimedAt" = now() AT TIME ZONE 'UTC',
          "lastAttemptAt" = now() AT TIME ZONE 'UTC',
          "attemptCount" = "attemptCount" + 1,
          "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "id" IN (
        SELECT "id" FROM "OpsAlertDelivery"
        WHERE ("status" IN ('PENDING', 'FAILED') AND "nextAttemptAt" <= now() AT TIME ZONE 'UTC')
           OR ("status" = 'SENDING'
               AND "claimedAt" < (now() AT TIME ZONE 'UTC') - (${DELIVERY_LEASE_MS}::int * INTERVAL '1 millisecond')
               AND "attemptCount" < ${DELIVERY_MAX_ATTEMPTS})
        ORDER BY "nextAttemptAt", "id"
        LIMIT ${DELIVERY_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    return rows.map((row) => row.id);
  }

  /** A claim that ran out on its last attempt is not taken again: it is over. */
  private async abandonExpiredClaims(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "OpsAlertDelivery"
      SET "status" = 'ABANDONED', "claimToken" = NULL, "claimedAt" = NULL,
          "errorCode" = 'LEASE_EXPIRED', "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "status" = 'SENDING'
        AND "claimedAt" < (now() AT TIME ZONE 'UTC') - (${DELIVERY_LEASE_MS}::int * INTERVAL '1 millisecond')
        AND "attemptCount" >= ${DELIVERY_MAX_ATTEMPTS}`;
  }

  private async deliverOne(id: string, token: string): Promise<'sent' | 'failed' | 'abandoned'> {
    const delivery = await this.prisma.opsAlertDelivery.findUnique({
      where: { id },
      select: {
        id: true,
        kind: true,
        channel: true,
        attemptCount: true,
        noticeSnapshot: true,
        alert: {
          select: {
            ref: true,
            source: true,
            subjectKey: true,
            condition: true,
            severity: true,
            firstSeenAt: true,
            lastSeenAt: true,
            occurrenceCount: true,
            resolvedAt: true,
            resolution: true,
            detail: true,
          },
        },
      },
    });
    if (!delivery) return 'failed';

    // Content frozen at queue time; a row from before the snapshot column composes live.
    const notice =
      readNoticeSnapshot(delivery.noticeSnapshot) ??
      composeNotice(delivery.kind, delivery.alert, systemHealthUrl(getAdminAppBaseUrl()));
    const config = readOpsAlertConfigSafely();
    try {
      let providerMessageId: string | null;
      if (delivery.channel === OpsAlertChannel.TELEGRAM) {
        if (!config.telegram) throw new TelegramSendError('NOT_CONFIGURED');
        providerMessageId = (await this.telegram.send(notice.telegramText)).providerMessageId;
      } else {
        if (!config.email) throw new ChannelNotConfiguredError();
        providerMessageId = (
          await this.email.send({
            template: 'ops-alert',
            to: config.email,
            subject: transactionalSubject('ops-alert', notice.emailData),
            data: notice.emailData,
            idempotencyKey: opsAlertIdempotencyKey(delivery.id),
            recipientLogPolicy: 'hidden',
          })
        ).providerMessageId;
      }

      await this.finish(id, token, {
        status: OpsAlertDeliveryStatus.SENT,
        sentAt: new Date(),
        errorCode: null,
        providerMessageId: providerMessageId?.slice(0, 200) ?? null,
      });
      return 'sent';
    } catch (error) {
      const code = deliveryErrorCode(error);
      const final = code === 'NOT_CONFIGURED' || delivery.attemptCount >= DELIVERY_MAX_ATTEMPTS;
      this.logger.warn(
        `ops alert ${delivery.alert.ref} ${delivery.kind} via ${delivery.channel} failed (${code}); ` +
          (final ? 'abandoned' : `attempt ${delivery.attemptCount}/${DELIVERY_MAX_ATTEMPTS}, retried later`),
      );
      await this.finish(id, token, {
        status: final ? OpsAlertDeliveryStatus.ABANDONED : OpsAlertDeliveryStatus.FAILED,
        errorCode: code,
        nextAttemptAt: new Date(Date.now() + deliveryBackoffMs(delivery.attemptCount)),
      });
      return final ? 'abandoned' : 'failed';
    }
  }

  /** Writes the outcome only while this worker still holds the claim. */
  private async finish(
    id: string,
    token: string,
    data: {
      status: OpsAlertDeliveryStatus;
      errorCode: string | null;
      sentAt?: Date;
      providerMessageId?: string | null;
      nextAttemptAt?: Date;
    },
  ) {
    try {
      const updated = await this.prisma.opsAlertDelivery.updateMany({
        where: { id, claimToken: token, status: OpsAlertDeliveryStatus.SENDING },
        data: { ...data, claimToken: null, claimedAt: null },
      });
      if (updated.count === 0) {
        this.logger.warn(`ops alert delivery outcome not recorded: its claim was taken over (${data.status})`);
      }
    } catch (error) {
      // The row stays SENDING; its lease runs out and it is taken again.
      this.logger.error(`ops alert delivery outcome could not be recorded (${error instanceof Error ? error.name : 'UnknownError'})`);
    }
  }
}

class ChannelNotConfiguredError extends Error {
  override name = 'ChannelNotConfiguredError';
  readonly code = 'NOT_CONFIGURED';
}

/** A closed code for either channel; a provider's text never survives this. */
export function deliveryErrorCode(error: unknown): string {
  if (error instanceof TelegramSendError) return error.code;
  if (error instanceof ChannelNotConfiguredError) return 'NOT_CONFIGURED';
  return classifyNotificationError(error);
}
