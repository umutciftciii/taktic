import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OpsAlertChannel,
  OpsAlertDeliveryStatus,
  OpsAlertEmailRouting,
  OpsAlertNoticeKind,
  OpsAlertRecipientStatus,
  OpsAlertSeverity,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyNotificationError } from '../notifications/notification-errors';
import { NotificationPort } from '../notifications/notification.port';
import { transactionalSubject } from '../notifications/templates/transactional-templates';
import { getAdminAppBaseUrl } from '../users/admin-invite.constants';
import { OpsAlertConfig, readOpsAlertConfigSafely } from './ops-alert.config';
import { OPS_ALERT_ROUTING_ID } from './ops-alert-recipient.constants';
import { RECIPIENT_REMOVED_ERROR_CODE } from './ops-alert-recipients.service';
import { addressHmac, decryptAddress, normalizeAddress } from './recipient-crypto';
import { resolveRecipientCryptoConfig } from './recipient-crypto.config';
import {
  DELIVERY_BATCH,
  DELIVERY_LEASE_MS,
  DELIVERY_MAX_ATTEMPTS,
  composeNotice,
  readNoticeSnapshot,
  recipientWants,
  deliveryBackoffMs,
  systemHealthUrl,
} from './ops-alert.rules';
import { TelegramAlertPort, TelegramSendError } from './telegram-alert.port';

/** The idempotency key an alert e-mail carries: the delivery row, nothing else. */
export function opsAlertIdempotencyKey(deliveryId: string): string {
  return `taktic-ops-alert-${deliveryId}`;
}

export type DeliveryPassOutcome = { claimed: number; sent: number; failed: number; abandoned: number; cancelled: number };
type DeliveryResult = 'sent' | 'failed' | 'abandoned' | 'cancelled';

/** Final, no-send outcomes of a recipient-bound row (OBS-ALERT-002). Closed codes, TEXT in the table. */
export const RECIPIENT_PAUSED_ERROR_CODE = 'RECIPIENT_PAUSED';
export const PREFERENCE_OFF_ERROR_CODE = 'PREFERENCE_OFF';
export const DECRYPT_FAILED_ERROR_CODE = 'DECRYPT_FAILED';
export const LEGACY_AFTER_CUTOVER_ERROR_CODE = 'LEGACY_AFTER_CUTOVER';
/** A recipient-bound row that met ENV_LEGACY: cancelled by the revert, or by the worker after it. */
export const ROUTING_REVERTED_ERROR_CODE = 'ROUTING_REVERTED';

/** Where a claimed e-mail row goes — or the final reason it goes nowhere. */
type EmailRoute =
  | { kind: 'legacy' }
  | { kind: 'recipient'; address: string }
  | { kind: 'cancel'; code: string }
  | { kind: 'abandon'; code: string }
  /** The claim was taken over while binding; the other worker owns the row now. */
  | { kind: 'lost' };

type ClaimedDelivery = {
  id: string;
  alertId: string;
  kind: OpsAlertNoticeKind;
  sequence: number;
  channel: OpsAlertChannel;
  recipientId: string | null;
  alert: { ref: string };
};

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
 * **Recipients (OBS-ALERT-002).** A row with a `recipientId` goes to that
 * recipient's address, decrypted at send time, or to nobody: a recipient
 * that was removed, paused or no longer wants the notice cancels the row
 * (final, no send, no retry), and an address that cannot be decrypted
 * abandons it (`DECRYPT_FAILED`). Such a row never falls back to
 * OPS_ALERT_EMAIL, in any routing mode; in ENV_LEGACY it is cancelled
 * (`ROUTING_REVERTED`) unless it is the env address's own last copy of the
 * notice (see {@link emailRoute}). A row without a recipient follows the
 * OBS-ALERT-001 path in ENV_LEGACY; in MANAGED it is first bound to the
 * ACTIVE recipient whose identity is the env address, or cancelled
 * (`LEGACY_AFTER_CUTOVER`). Every one of these outcomes is written under the
 * claim token, like a send's.
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
    const outcome: DeliveryPassOutcome = { claimed: 0, sent: 0, failed: 0, abandoned: 0, cancelled: 0 };
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

  private async deliverOne(id: string, token: string): Promise<DeliveryResult> {
    const delivery = await this.prisma.opsAlertDelivery.findUnique({
      where: { id },
      select: {
        id: true,
        alertId: true,
        kind: true,
        sequence: true,
        channel: true,
        recipientId: true,
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
    const snapshot = readNoticeSnapshot(delivery.noticeSnapshot);
    const notice = snapshot ?? composeNotice(delivery.kind, delivery.alert, systemHealthUrl(getAdminAppBaseUrl()));
    const config = readOpsAlertConfigSafely();
    try {
      let providerMessageId: string | null;
      if (delivery.channel === OpsAlertChannel.TELEGRAM) {
        if (!config.telegram) throw new TelegramSendError('NOT_CONFIGURED');
        providerMessageId = (await this.telegram.send(notice.telegramText)).providerMessageId;
      } else {
        // Where this e-mail may go is settled before anything is sent.
        const route = await this.emailRoute(delivery, token, config, snapshot?.severity ?? delivery.alert.severity);
        if (route.kind === 'cancel') return this.stop(delivery, token, OpsAlertDeliveryStatus.CANCELLED, route.code);
        if (route.kind === 'abandon') return this.stop(delivery, token, OpsAlertDeliveryStatus.ABANDONED, route.code);
        if (route.kind === 'lost') return 'failed';
        let to: string;
        if (route.kind === 'recipient') {
          to = route.address;
        } else {
          // ENV_LEGACY, a row with no recipient: the OBS-ALERT-001 path, unchanged.
          if (!config.email) throw new ChannelNotConfiguredError();
          to = config.email;
        }
        providerMessageId = (
          await this.email.send({
            template: 'ops-alert',
            to,
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

  /**
   * Where one claimed e-mail row may go (OBS-ALERT-002).
   *
   *   bound, MANAGED                that recipient's address, decrypted now,
   *                                 or nowhere (see recipientRoute)
   *   bound, ENV_LEGACY             cancelled (ROUTING_REVERTED): only the env
   *                                 address gets e-mail in this mode, and a
   *                                 send the revert found in flight must not
   *                                 be retried to its recipient. Except the
   *                                 env address's own recipient (same HMAC)
   *                                 when no live legacy row exists for the
   *                                 notice — then this row is that mailbox's
   *                                 only copy and goes as in MANAGED
   *   no recipient, ENV_LEGACY      the OBS-ALERT-001 path: OPS_ALERT_EMAIL
   *   no recipient, MANAGED         bound now to the ACTIVE recipient whose
   *                                 identity is the env address, then as
   *                                 above; with no such recipient, cancelled
   *
   * A row with a recipient never reaches the env address, whatever the mode.
   */
  private async emailRoute(
    delivery: ClaimedDelivery,
    token: string,
    config: OpsAlertConfig,
    severity: OpsAlertSeverity,
  ): Promise<EmailRoute> {
    const settings = await this.prisma.opsAlertRoutingSettings.findUnique({
      where: { id: OPS_ALERT_ROUTING_ID },
      select: { emailRouting: true },
    });
    const managed = (settings?.emailRouting ?? OpsAlertEmailRouting.ENV_LEGACY) === OpsAlertEmailRouting.MANAGED;
    let recipientId = delivery.recipientId;
    if (recipientId === null) {
      if (!managed) return { kind: 'legacy' };
      const bound = await this.bindLegacyRow(delivery, token, config);
      if (bound.kind !== 'bound') return bound;
      recipientId = bound.recipientId;
    } else if (!managed && !(await this.lastCopyForEnvAddress(delivery, recipientId, config))) {
      return { kind: 'cancel', code: ROUTING_REVERTED_ERROR_CODE };
    }
    return this.recipientRoute(delivery.kind, severity, recipientId);
  }

  /**
   * ENV_LEGACY, a bound row: is it the env address's only copy of the notice?
   * Yes when its recipient is the env address (same HMAC and key version) and
   * no legacy row for the notice is live (PENDING/FAILED/SENDING/SENT) — e.g.
   * a worker that read MANAGED bound a legacy row just after a revert. Then
   * it goes to that recipient, the same mailbox; otherwise the legacy row
   * owns the notice, or the recipient is somebody else, and this row stops.
   */
  private async lastCopyForEnvAddress(delivery: ClaimedDelivery, recipientId: string, config: OpsAlertConfig): Promise<boolean> {
    const identity = envIdentity(config);
    if (!identity) return false;
    const recipient = await this.prisma.opsAlertRecipient.findFirst({
      where: { id: recipientId, addressHmac: identity.hmac, addressHmacVersion: identity.version },
      select: { id: true },
    });
    if (!recipient) return false;
    const legacy = await this.prisma.opsAlertDelivery.findFirst({
      where: {
        alertId: delivery.alertId,
        kind: delivery.kind,
        sequence: delivery.sequence,
        channel: OpsAlertChannel.EMAIL,
        recipientId: null,
        status: { notIn: [OpsAlertDeliveryStatus.CANCELLED, OpsAlertDeliveryStatus.ABANDONED] },
      },
      select: { id: true },
    });
    return legacy === null;
  }

  /**
   * The bound recipient's address, read at send time. Removed, paused, or no
   * longer wanting this notice (OPENED/REMINDER by the severity frozen in the
   * row, RESOLVED by recovery) → cancelled, final. An address that cannot be
   * decrypted — its key left the keyring, or the ciphertext does not belong
   * to this recipient — → abandoned; there is no other address to try.
   *
   * A recipient deleted while a send to it is in flight may still get that
   * one letter; the delete shreds the ciphertext, so no retry can follow it.
   */
  private async recipientRoute(kind: OpsAlertNoticeKind, severity: OpsAlertSeverity, recipientId: string): Promise<EmailRoute> {
    const recipient = await this.prisma.opsAlertRecipient.findUnique({
      where: { id: recipientId },
      select: {
        status: true,
        notifyWarning: true,
        notifyCritical: true,
        notifyRecovery: true,
        addressCiphertext: true,
        addressNonce: true,
        addressTag: true,
        addressKeyId: true,
      },
    });
    // A missing row cannot happen (the foreign key restricts deletes); it reads as removed.
    if (!recipient || recipient.status === OpsAlertRecipientStatus.DELETED) {
      return { kind: 'cancel', code: RECIPIENT_REMOVED_ERROR_CODE };
    }
    if (recipient.status === OpsAlertRecipientStatus.PAUSED) return { kind: 'cancel', code: RECIPIENT_PAUSED_ERROR_CODE };
    if (!recipientWants(kind, severity, recipient)) return { kind: 'cancel', code: PREFERENCE_OFF_ERROR_CODE };

    const { addressCiphertext, addressNonce, addressTag, addressKeyId } = recipient;
    if (!addressCiphertext || !addressNonce || !addressTag || !addressKeyId) {
      return { kind: 'abandon', code: DECRYPT_FAILED_ERROR_CODE };
    }
    try {
      const address = decryptAddress(resolveRecipientCryptoConfig(), recipientId, {
        ciphertext: Buffer.from(addressCiphertext),
        nonce: Buffer.from(addressNonce),
        tag: Buffer.from(addressTag),
        keyId: addressKeyId,
      });
      return { kind: 'recipient', address };
    } catch {
      // RecipientDecryptError, or a keyring the process can no longer read: one answer.
      return { kind: 'abandon', code: DECRYPT_FAILED_ERROR_CODE };
    }
  }

  /**
   * A legacy row (no recipient) found in MANAGED mode: it was queued for the
   * env address before the cutover. It is bound to the ACTIVE recipient whose
   * identity HMAC (same key version) is the env address's — the same mailbox
   * — inside this worker's claim, and only while the row is still unbound.
   * Without such a recipient, or when that recipient already has its own row
   * for this notice (the managed unique key would refuse the bind, and the
   * notice is already theirs), the legacy row is cancelled.
   */
  private async bindLegacyRow(
    delivery: ClaimedDelivery,
    token: string,
    config: OpsAlertConfig,
  ): Promise<{ kind: 'bound'; recipientId: string } | { kind: 'cancel'; code: string } | { kind: 'lost' }> {
    const unmatched = { kind: 'cancel', code: LEGACY_AFTER_CUTOVER_ERROR_CODE } as const;
    const identity = envIdentity(config);
    if (!identity) return unmatched;
    const match = await this.prisma.opsAlertRecipient.findFirst({
      where: {
        status: OpsAlertRecipientStatus.ACTIVE,
        channel: OpsAlertChannel.EMAIL,
        addressHmac: identity.hmac,
        addressHmacVersion: identity.version,
      },
      select: { id: true },
    });
    if (!match) return unmatched;
    const existing = await this.prisma.opsAlertDelivery.findFirst({
      where: { alertId: delivery.alertId, kind: delivery.kind, sequence: delivery.sequence, recipientId: match.id },
      select: { id: true },
    });
    if (existing) return unmatched;

    try {
      const bound = await this.prisma.opsAlertDelivery.updateMany({
        where: { id: delivery.id, claimToken: token, status: OpsAlertDeliveryStatus.SENDING, recipientId: null },
        data: { recipientId: match.id },
      });
      if (bound.count === 0) {
        this.logger.warn(`ops alert ${delivery.alert.ref} ${delivery.kind} not bound: its claim was taken over`);
        return { kind: 'lost' };
      }
    } catch (error) {
      // A managed row for the same notice appeared since the check above.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return unmatched;
      throw error;
    }
    return { kind: 'bound', recipientId: match.id };
  }

  /** A final outcome without a send: cancelled or abandoned, under this worker's claim. */
  private async stop(
    delivery: ClaimedDelivery,
    token: string,
    status: typeof OpsAlertDeliveryStatus.CANCELLED | typeof OpsAlertDeliveryStatus.ABANDONED,
    code: string,
  ): Promise<DeliveryResult> {
    this.logger.warn(
      `ops alert ${delivery.alert.ref} ${delivery.kind} via ${delivery.channel} ` +
        `${status === OpsAlertDeliveryStatus.CANCELLED ? 'cancelled' : 'abandoned'} (${code}); nothing sent`,
    );
    await this.finish(delivery.id, token, { status, errorCode: code });
    return status === OpsAlertDeliveryStatus.CANCELLED ? 'cancelled' : 'abandoned';
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

/** The env address's identity, or null when it is unset or not a plain address. */
function envIdentity(config: OpsAlertConfig): { hmac: string; version: number } | null {
  if (!config.email) return null;
  try {
    return addressHmac(resolveRecipientCryptoConfig(), normalizeAddress(config.email));
  } catch {
    return null;
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
