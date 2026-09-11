import { Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { maskEmail } from './mask';
import { NotificationDispatcher } from './notification-dispatcher.service';
import type { TransactionalMailService } from './transactional-mail.service';
import type { TransactionalEmailTemplate } from './templates/transactional-templates';

/**
 * The mechanics every intent outbox shares: what an un-attempted intent row
 * looks like, which rows a sweep may take, and the claim-compose-send loop.
 *
 * Two outboxes exist — the request expiry's and the vitrin run's — and they
 * are the same idea applied to two clocks: write down *that* a message is owed
 * inside the transaction that made it owed, and deliver it in a separate,
 * resumable pass. The reasoning behind each half lives on
 * {@link import('./request-expiry-outbox.service').RequestExpiryOutbox}, which
 * was the first; this file holds the parts that would otherwise be typed
 * twice and drift.
 *
 * There is no new queue and no new table. A `NotificationLog` row in PENDING
 * with `attemptCount = 0` *is* the intent: the table already says "this
 * message was owed to this masked recipient for this transition", already
 * carries the dedupe key the unique index enforces, and already has the two
 * columns a claim needs.
 */

/**
 * How long a claim is honoured before another runner may take the row.
 *
 * Fifteen minutes is comfortably longer than any send takes and short enough
 * that a crashed pass recovers within a tick or two. Re-attempting a claim
 * whose outcome is unknown is safe rather than duplicative: the transport is
 * offered the same idempotency key both times, derived from the row id.
 */
export const INTENT_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type IntentDeliveryResult = {
  /** Intents this sweep claimed. */
  claimed: number;
  /** Of those, the ones the transport accepted. */
  sent: number;
  /** Of those, the ones it refused. They are FAILED now and stay FAILED. */
  failed: number;
  /** Claimed rows whose source could no longer be composed. Also FAILED. */
  unavailable: number;
};

/**
 * One un-attempted intent.
 *
 * `attemptCount: 0` is the only place in this system a notification row starts
 * at zero, and it says exactly what is true: the row exists because a message
 * is owed, not because one has been tried. `lastAttemptAt: null` for the same
 * reason, and it is what the sweep's predicate reads as "never claimed".
 */
export function intentRow(input: {
  template: TransactionalEmailTemplate;
  to: string;
  dedupeKey: string;
  requestId: string | null;
  userId: string | null;
  providerId: string | null;
}): Prisma.NotificationLogCreateManyInput {
  return {
    channel: NotificationChannel.EMAIL,
    template: input.template,
    maskedRecipient: maskEmail(input.to),
    status: NotificationStatus.PENDING,
    requestId: input.requestId,
    userId: input.userId,
    providerId: input.providerId,
    dedupeKey: input.dedupeKey,
    attemptCount: 0,
    lastAttemptAt: null,
  };
}

/**
 * What a sweep may take: an intent that is still owed and that nobody is
 * currently sending.
 *
 * PENDING only — a FAILED row is settled and is an operator's decision, never
 * a sweep's. Of the PENDING rows, one that has never been claimed, or one
 * whose claim is older than the lease and therefore belongs to a runner that
 * is not coming back.
 */
export function claimablePredicate(
  templates: readonly TransactionalEmailTemplate[],
  now: Date,
): Prisma.NotificationLogWhereInput {
  return {
    template: { in: [...templates] },
    status: NotificationStatus.PENDING,
    OR: [
      { lastAttemptAt: null },
      { lastAttemptAt: { lt: new Date(now.getTime() - INTENT_CLAIM_LEASE_MS) } },
    ],
  };
}

/**
 * Delivers the intents of the given templates that are still owed.
 *
 * Each row is taken by a conditional update that repeats the whole predicate,
 * so two API instances sweeping at the same moment produce one claim and one
 * send; the loser matches nothing and moves on. The claim is what counts the
 * attempt, so a process that dies mid-send has still recorded that it tried.
 *
 * The message is re-derived from the dedupe key through the same
 * `composeRetryMessage` path the admin re-send uses, so an intent enqueued by
 * one process and delivered by another is composed from live domain data with
 * every recipient rule re-applied. A source that no longer supports the
 * message — a run that was suspended, a provider with no address left — is
 * settled as FAILED with `SOURCE_UNAVAILABLE` rather than re-claimed for ever.
 *
 * Never throws. The caller is a scheduler tick whose transition has already
 * committed, and a sweep that could take the job down would be a worse failure
 * than an undelivered notice.
 */
export async function deliverPendingIntents(input: {
  prisma: PrismaService;
  dispatcher: NotificationDispatcher;
  mail: Pick<TransactionalMailService, 'composeRetryMessage'>;
  logger: Logger;
  templates: readonly TransactionalEmailTemplate[];
  limit: number;
  label: string;
}): Promise<IntentDeliveryResult> {
  const { prisma, dispatcher, mail, logger, templates, limit, label } = input;
  const result: IntentDeliveryResult = { claimed: 0, sent: 0, failed: 0, unavailable: 0 };

  const candidates = await prisma.notificationLog.findMany({
    where: claimablePredicate(templates, new Date()),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, template: true, dedupeKey: true, maskedRecipient: true },
  });

  for (const candidate of candidates) {
    // Re-evaluated at claim time rather than reused from the scan: a row
    // another runner took while this loop was working is no longer claimable,
    // and PostgreSQL decides that after the row lock.
    const claim = await prisma.notificationLog.updateMany({
      where: { id: candidate.id, ...claimablePredicate(templates, new Date()) },
      data: { lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
    });

    if (claim.count !== 1) {
      continue;
    }

    result.claimed += 1;

    const message = await mail.composeRetryMessage(candidate.template, candidate.dedupeKey);

    // The rebuilt address has to be the recorded one. The raw address was
    // never stored, but the mask is a strong enough statement: a message that
    // would now go somewhere else is not this intent.
    if (!message || maskEmail(message.to) !== candidate.maskedRecipient) {
      result.unavailable += 1;
      logger.warn(`[${candidate.template}] ${label} notice unavailable for ${candidate.maskedRecipient}`);
      await prisma.notificationLog.update({
        where: { id: candidate.id },
        data: {
          status: NotificationStatus.FAILED,
          failedAt: new Date(),
          errorCode: 'SOURCE_UNAVAILABLE',
        },
      });
      continue;
    }

    const outcome = await dispatcher.resendExistingEmail(
      candidate.id,
      message,
      candidate.maskedRecipient,
    );

    if (outcome.status === NotificationStatus.SENT) {
      result.sent += 1;
    } else {
      result.failed += 1;
    }
  }

  if (result.claimed > 0) {
    logger.log(
      `${label} outbox claimed=${result.claimed} sent=${result.sent} ` +
        `failed=${result.failed} unavailable=${result.unavailable}`,
    );
  }

  return result;
}
