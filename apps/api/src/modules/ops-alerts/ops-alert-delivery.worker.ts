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
  /** The claim was taken over before routing; the other worker owns the row now. */
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
 * notice (see {@link emailRoute}). The route is decided, and a no-send
 * outcome written, in one transaction under the row's lock, on the row's
 * recipient and the mode as they are then — a cutover or revert can move a
 * claimed row. A row without a recipient follows the
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
        if (route.kind === 'cancel') return this.stopped(delivery, OpsAlertDeliveryStatus.CANCELLED, route.code);
        if (route.kind === 'abandon') return this.stopped(delivery, OpsAlertDeliveryStatus.ABANDONED, route.code);
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
   *                                 notice: that row is the mailbox's only
   *                                 copy (see envAddressOwnRoute)
   *   no recipient, ENV_LEGACY      the OBS-ALERT-001 path: OPS_ALERT_EMAIL
   *   no recipient, MANAGED         bound now to the ACTIVE recipient whose
   *                                 identity is the env address, then as
   *                                 above; with no such recipient, cancelled
   *
   * A row with a recipient never reaches the env address, whatever the mode.
   *
   * **Decided on fresh state, under the row's lock.** A cutover or revert
   * moves a SENDING row by its link column alone and keeps its claim, so the
   * `recipientId` read when the row was loaded may be stale by now. The
   * decision is therefore one transaction that locks the row — still SENDING
   * under this worker's claim — and only then reads its `recipientId` and the
   * routing mode. A switch locks the same row FOR UPDATE: it either committed
   * before this read (and both reads see it) or waits until this transaction
   * commits. A no-send outcome (cancel, abandon) is written inside it, so it
   * can never land on a row a switch has moved since. A send happens after
   * it, to the address decided here: a switch landing in between finds the
   * row in flight and keeps the claim, and the outcome is recorded as it is.
   */
  private async emailRoute(
    delivery: ClaimedDelivery,
    token: string,
    config: OpsAlertConfig,
    severity: OpsAlertSeverity,
  ): Promise<EmailRoute> {
    try {
      return await this.prisma.$transaction((tx) => this.routeLocked(tx, delivery, token, config, severity));
    } catch (error) {
      // A managed row for the same notice appeared between the check and the
      // bind; the failed statement aborted the transaction. Decide again: it is found now.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.$transaction((tx) => this.routeLocked(tx, delivery, token, config, severity));
      }
      throw error;
    }
  }

  private async routeLocked(
    tx: Prisma.TransactionClient,
    delivery: ClaimedDelivery,
    token: string,
    config: OpsAlertConfig,
    severity: OpsAlertSeverity,
  ): Promise<EmailRoute> {
    const [row] = await tx.$queryRaw<Array<{ recipientId: string | null }>>`
      SELECT "recipientId" FROM "OpsAlertDelivery"
      WHERE "id" = ${delivery.id} AND "claimToken" = ${token} AND "status" = 'SENDING'
      FOR UPDATE`;
    if (!row) {
      this.logger.warn(`ops alert ${delivery.alert.ref} ${delivery.kind} not routed: its claim was taken over`);
      return { kind: 'lost' };
    }
    const settings = await tx.opsAlertRoutingSettings.findUnique({
      where: { id: OPS_ALERT_ROUTING_ID },
      select: { emailRouting: true },
    });
    const managed = (settings?.emailRouting ?? OpsAlertEmailRouting.ENV_LEGACY) === OpsAlertEmailRouting.MANAGED;

    let route: EmailRoute;
    if (row.recipientId === null) {
      if (!managed) return { kind: 'legacy' };
      const bound = await this.bindLegacyRow(tx, delivery, config);
      route = bound.kind === 'bound' ? await this.recipientRoute(tx, delivery.kind, severity, bound.recipientId) : bound;
    } else if (managed) {
      route = await this.recipientRoute(tx, delivery.kind, severity, row.recipientId);
    } else {
      route = await this.envAddressOwnRoute(tx, delivery, row.recipientId, config);
    }

    if (route.kind === 'cancel' || route.kind === 'abandon') {
      // Under the lock taken above, so the claim is still this worker's.
      await tx.opsAlertDelivery.updateMany({
        where: { id: delivery.id, claimToken: token, status: OpsAlertDeliveryStatus.SENDING },
        data: {
          status: route.kind === 'cancel' ? OpsAlertDeliveryStatus.CANCELLED : OpsAlertDeliveryStatus.ABANDONED,
          errorCode: route.code,
          claimToken: null,
          claimedAt: null,
        },
      });
    }
    return route;
  }

  /**
   * ENV_LEGACY, a bound row. ENV_LEGACY e-mails the env address and nobody
   * else, so the row is cancelled (ROUTING_REVERTED) — unless its recipient
   * is the env address itself (same HMAC and key version) and no legacy row
   * for the notice is live (PENDING/FAILED/SENDING/SENT): then this row is
   * that mailbox's only copy (left bound by hand, or by an env address that
   * changed). It goes the ENV_LEGACY way: the recipient's pause and
   * preferences do not apply, as they do not to OPS_ALERT_EMAIL.
   *
   *   no legacy row at all   un-bound and sent on the legacy path, so the
   *                          env address's "told" is what resolve() reads
   *   only dead legacy rows  the legacy key is taken: sent to the recipient's
   *                          address (the same mailbox), still bound
   */
  private async envAddressOwnRoute(
    tx: Prisma.TransactionClient,
    delivery: ClaimedDelivery,
    recipientId: string,
    config: OpsAlertConfig,
  ): Promise<EmailRoute> {
    const reverted = { kind: 'cancel', code: ROUTING_REVERTED_ERROR_CODE } as const;
    const identity = envIdentity(config);
    if (!identity) return reverted;
    const own = await tx.opsAlertRecipient.findFirst({
      where: { id: recipientId, addressHmac: identity.hmac, addressHmacVersion: identity.version },
      select: { id: true },
    });
    if (!own) return reverted;
    const legacy = await tx.opsAlertDelivery.findMany({
      where: {
        id: { not: delivery.id },
        alertId: delivery.alertId,
        kind: delivery.kind,
        sequence: delivery.sequence,
        channel: OpsAlertChannel.EMAIL,
        recipientId: null,
      },
      select: { status: true },
    });
    const dead: OpsAlertDeliveryStatus[] = [OpsAlertDeliveryStatus.CANCELLED, OpsAlertDeliveryStatus.ABANDONED];
    if (legacy.some((row) => !dead.includes(row.status))) return reverted;
    if (legacy.length === 0) {
      await tx.opsAlertDelivery.update({ where: { id: delivery.id }, data: { recipientId: null } });
      return { kind: 'legacy' };
    }
    return this.recipientAddress(tx, recipientId);
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
  private async recipientRoute(
    client: Prisma.TransactionClient,
    kind: OpsAlertNoticeKind,
    severity: OpsAlertSeverity,
    recipientId: string,
  ): Promise<EmailRoute> {
    const recipient = await client.opsAlertRecipient.findUnique({
      where: { id: recipientId },
      select: { status: true, notifyWarning: true, notifyCritical: true, notifyRecovery: true },
    });
    // A missing row cannot happen (the foreign key restricts deletes); it reads as removed.
    if (!recipient || recipient.status === OpsAlertRecipientStatus.DELETED) {
      return { kind: 'cancel', code: RECIPIENT_REMOVED_ERROR_CODE };
    }
    if (recipient.status === OpsAlertRecipientStatus.PAUSED) return { kind: 'cancel', code: RECIPIENT_PAUSED_ERROR_CODE };
    if (!recipientWants(kind, severity, recipient)) return { kind: 'cancel', code: PREFERENCE_OFF_ERROR_CODE };
    return this.recipientAddress(client, recipientId);
  }

  /** The recipient's address, decrypted now; removed → cancelled, undecryptable → abandoned. */
  private async recipientAddress(client: Prisma.TransactionClient, recipientId: string): Promise<EmailRoute> {
    const recipient = await client.opsAlertRecipient.findUnique({
      where: { id: recipientId },
      select: { status: true, addressCiphertext: true, addressNonce: true, addressTag: true, addressKeyId: true },
    });
    if (!recipient || recipient.status === OpsAlertRecipientStatus.DELETED) {
      return { kind: 'cancel', code: RECIPIENT_REMOVED_ERROR_CODE };
    }
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
   * — under the routing transaction's lock on the row. Without such a
   * recipient, or when that recipient already has its own row for this notice
   * (the managed unique key would refuse the bind, and the notice is already
   * theirs), the legacy row is cancelled.
   */
  private async bindLegacyRow(
    tx: Prisma.TransactionClient,
    delivery: ClaimedDelivery,
    config: OpsAlertConfig,
  ): Promise<{ kind: 'bound'; recipientId: string } | { kind: 'cancel'; code: string }> {
    const unmatched = { kind: 'cancel', code: LEGACY_AFTER_CUTOVER_ERROR_CODE } as const;
    const identity = envIdentity(config);
    if (!identity) return unmatched;
    const match = await tx.opsAlertRecipient.findFirst({
      where: {
        status: OpsAlertRecipientStatus.ACTIVE,
        channel: OpsAlertChannel.EMAIL,
        addressHmac: identity.hmac,
        addressHmacVersion: identity.version,
      },
      select: { id: true },
    });
    if (!match) return unmatched;
    const existing = await tx.opsAlertDelivery.findFirst({
      where: {
        id: { not: delivery.id },
        alertId: delivery.alertId,
        kind: delivery.kind,
        sequence: delivery.sequence,
        recipientId: match.id,
      },
      select: { id: true },
    });
    if (existing) return unmatched;
    // The row is locked and still unbound (read under the lock); a P2002 here is a managed
    // row for the notice that appeared since the check above, and emailRoute decides again.
    await tx.opsAlertDelivery.update({ where: { id: delivery.id }, data: { recipientId: match.id } });
    return { kind: 'bound', recipientId: match.id };
  }

  /** A final outcome without a send, already written by the routing transaction under this worker's claim. */
  private stopped(
    delivery: ClaimedDelivery,
    status: typeof OpsAlertDeliveryStatus.CANCELLED | typeof OpsAlertDeliveryStatus.ABANDONED,
    code: string,
  ): DeliveryResult {
    this.logger.warn(
      `ops alert ${delivery.alert.ref} ${delivery.kind} via ${delivery.channel} ` +
        `${status === OpsAlertDeliveryStatus.CANCELLED ? 'cancelled' : 'abandoned'} (${code}); nothing sent`,
    );
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
