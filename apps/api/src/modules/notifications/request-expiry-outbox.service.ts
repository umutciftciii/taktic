import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NotificationChannel,
  NotificationStatus,
  OfferStatus,
  Prisma,
  ServiceRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { maskEmail } from './mask';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { recipientFor, TransactionalMailService } from './transactional-mail.service';

/**
 * The durable half of the expiry notice: writing down *that* a message is owed,
 * separately from sending it.
 *
 * **The gap this closes.** The status transition and the messages used to be
 * two independent steps with a commit between them: the request became EXPIRED,
 * and only then was anything composed. A process that died in that window left
 * an expired request that no later run could ever notice — the expiry job's
 * candidate query only looks at APPROVED rows, so the request was permanently
 * past the one thing that would have mailed anybody, and no NotificationLog row
 * existed to say a message had ever been owed.
 *
 * **The fix, in one sentence:** the intent is written inside the transaction
 * that expires the request, and delivery is a separate, resumable pass over
 * intents.
 *
 * There is no new queue and no new table. A `NotificationLog` row in PENDING
 * *is* the intent — that table already exists to say "this message was owed to
 * this masked recipient for this transition", already carries the dedupe key
 * the unique index enforces, and already has the two columns a claim needs
 * (`lastAttemptAt`, `attemptCount`). What is new is a row that exists *before*
 * anything has been handed to a transport, which is what `attemptCount = 0`
 * says and what {@link RequestExpiryOutbox.enqueue} writes.
 *
 * Delivery re-derives everything from the dedupe key through the same
 * `composeRetryMessage` path the admin re-send uses, so an intent enqueued by
 * one process and delivered by another — or by a later tick, after a crash —
 * is composed from live domain data with every recipient rule re-applied. A
 * provider who withdrew in between gets nothing.
 *
 * **What this deliberately does not do** is retry failures. The sweep looks at
 * PENDING rows only. A row the transport refused is FAILED and stays FAILED,
 * visible in the notification history and re-sendable by an operator and by
 * nobody else — the same contract every other message in this system has, and
 * the reason a broken transport cannot turn one undelivered notice into a flood.
 */

/** The two templates one expiry produces, and the only rows this sweep touches. */
export const REQUEST_EXPIRED_TEMPLATES = [
  'request-expired-customer',
  'request-expired-provider',
] as const;

/**
 * How long a claim is honoured before another runner may take the row.
 *
 * A claim marks "somebody is sending this right now". If that process dies
 * between the claim and the transport's answer, the row would otherwise stay
 * PENDING for ever — the very durability hole this service exists to close,
 * moved one step later. Fifteen minutes is comfortably longer than any send
 * takes and short enough that a crashed pass recovers within a tick or two.
 *
 * Re-attempting a claim whose outcome is genuinely unknown is safe rather than
 * duplicative: the transport is offered the same idempotency key both times,
 * derived from the row id, so a first attempt that really did deliver is
 * de-duplicated by the provider instead of arriving twice.
 */
export const EXPIRY_OUTBOX_CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Intents one sweep may deliver. Matches the job's own scan limit by default. */
const DEFAULT_DELIVERY_LIMIT = 200;

export type ExpiryOutboxDeliveryResult = {
  /** Intents this sweep claimed. */
  claimed: number;
  /** Of those, the ones the transport accepted. */
  sent: number;
  /** Of those, the ones it refused. They are FAILED now and stay FAILED. */
  failed: number;
  /** Claimed rows whose source could no longer be composed. Also FAILED. */
  unavailable: number;
};

@Injectable()
export class RequestExpiryOutbox {
  private readonly logger = new Logger(RequestExpiryOutbox.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * Writes down every message this expiry owes, inside the caller's transaction.
   *
   * Takes a transaction client rather than reaching for its own, and that is
   * the whole point: these rows and the `APPROVED → EXPIRED` update commit
   * together or not at all. A transition that survives therefore always has its
   * intents beside it, and a transition that rolls back leaves none — so a
   * skipped candidate, a request that became MATCHED in the meantime, or a
   * failed update produce exactly zero intents without anything having to
   * remember to check.
   *
   * Nothing is sent here and no transport is touched. This is a database write
   * inside somebody else's transaction; if it could talk to a mail provider it
   * would be holding row locks open across the network.
   *
   * `skipDuplicates` rather than a pre-read: the unique index on
   * `(template, dedupeKey)` is the authority on "already owed", and a colliding
   * insert must not abort the expiry that is committing alongside it. Two
   * runners that somehow both got here converge on one row per recipient.
   *
   * The audience is the same one the messages have always had — the customer,
   * and each provider whose offer is not withdrawn. Nothing about a recipient
   * is stored beyond the mask the audit row has always held.
   */
  async enqueue(tx: Prisma.TransactionClient, requestId: string): Promise<number> {
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: { id: true, status: true, customerId: true, customerEmail: true },
    });

    // Inside the caller's transaction this is the post-update state, so it is
    // the transition's own answer rather than a guess about it.
    if (!request || request.status !== ServiceRequestStatus.EXPIRED) {
      return 0;
    }

    const intents: Prisma.NotificationLogCreateManyInput[] = [];
    const customerEmail = request.customerEmail?.trim();

    if (customerEmail) {
      intents.push(
        intentRow({
          template: 'request-expired-customer',
          to: customerEmail,
          dedupeKey: `request-expired-customer:${request.id}`,
          requestId: request.id,
          userId: request.customerId,
          providerId: null,
        }),
      );
    }

    const offers = await tx.offer.findMany({
      where: { requestId: request.id, status: { not: OfferStatus.WITHDRAWN } },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: {
        providerId: true,
        provider: { select: { userId: true, email: true, user: { select: { email: true } } } },
      },
    });

    for (const offer of offers) {
      const recipient = recipientFor(offer.provider);
      if (!recipient) {
        continue;
      }

      intents.push(
        intentRow({
          template: 'request-expired-provider',
          to: recipient,
          dedupeKey: `request-expired-provider:${request.id}:${offer.providerId}`,
          requestId: request.id,
          userId: offer.provider.userId,
          providerId: offer.providerId,
        }),
      );
    }

    if (intents.length === 0) {
      return 0;
    }

    const created = await tx.notificationLog.createMany({
      data: intents,
      skipDuplicates: true,
    });

    return created.count;
  }

  /**
   * Delivers the intents that are still owed — this tick's and any earlier
   * tick's.
   *
   * One pass, run at the end of every request-expiry tick, and the only thing
   * that ever sends these messages. There is no admin "send now" and no
   * scheduler of its own: a message that moves nothing but a person's inbox
   * still belongs to the job whose transition produced it.
   *
   * Each row is taken by a conditional update that repeats the whole predicate,
   * so two API instances sweeping at the same moment produce one claim and one
   * send; the loser matches nothing and moves on. The claim is what counts the
   * attempt, so a process that dies mid-send has still recorded that it tried.
   *
   * Never throws. The caller is a scheduler tick whose transition has already
   * committed, and a sweep that could take the job down would be a worse
   * failure than an undelivered notice.
   */
  async deliverPending(options: { limit?: number } = {}): Promise<ExpiryOutboxDeliveryResult> {
    const limit = options.limit ?? DEFAULT_DELIVERY_LIMIT;
    const result: ExpiryOutboxDeliveryResult = {
      claimed: 0,
      sent: 0,
      failed: 0,
      unavailable: 0,
    };

    const candidates = await this.prisma.notificationLog.findMany({
      where: claimablePredicate(new Date()),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, template: true, dedupeKey: true, maskedRecipient: true },
    });

    for (const candidate of candidates) {
      // Re-evaluated at claim time rather than reused from the scan: a row
      // another runner took while this loop was working is no longer claimable,
      // and PostgreSQL decides that after the row lock.
      const claim = await this.prisma.notificationLog.updateMany({
        where: { id: candidate.id, ...claimablePredicate(new Date()) },
        data: { lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
      });

      if (claim.count !== 1) {
        continue;
      }

      result.claimed += 1;

      const message = await this.mail.composeRetryMessage(candidate.template, candidate.dedupeKey);

      // The rebuilt address has to be the recorded one. The raw address was
      // never stored, but the mask is a strong enough statement: a message that
      // would now go somewhere else is not this intent, and a source that is
      // gone — a withdrawn offer, a provider with no address left — is exactly
      // the case this must refuse rather than guess at.
      if (!message || maskEmail(message.to) !== candidate.maskedRecipient) {
        result.unavailable += 1;
        await this.recordUnavailable(candidate.id, candidate.template, candidate.maskedRecipient);
        continue;
      }

      const outcome = await this.dispatcher.resendExistingEmail(
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
      this.logger.log(
        `Request expiry outbox claimed=${result.claimed} sent=${result.sent} ` +
          `failed=${result.failed} unavailable=${result.unavailable}`,
      );
    }

    return result;
  }

  /**
   * Settles a claimed row whose source can no longer be composed.
   *
   * FAILED rather than left PENDING, and that is load-bearing: a row this sweep
   * can never compose would otherwise be re-claimed every time its lease
   * expired, for ever. FAILED is also the truthful state — the message was
   * owed and will not be sent — and it is the state an operator can see and act
   * on. Nothing about the source is recorded; which row is gone is a fact about
   * the domain, not about this message.
   */
  private async recordUnavailable(
    id: string,
    template: string,
    maskedRecipient: string,
  ): Promise<void> {
    this.logger.warn(`[${template}] expiry notice unavailable for ${maskedRecipient}`);

    await this.prisma.notificationLog.update({
      where: { id },
      data: {
        status: NotificationStatus.FAILED,
        failedAt: new Date(),
        errorCode: 'SOURCE_UNAVAILABLE',
      },
    });
  }
}

/**
 * One un-attempted intent.
 *
 * `attemptCount: 0` is the only place in this system a notification row starts
 * at zero, and it says exactly what is true: the row exists because a message
 * is owed, not because one has been tried. Every other row is created by the
 * dispatcher at the moment it hands something to a transport, which is why the
 * column's default is 1.
 *
 * `lastAttemptAt: null` for the same reason, and it is what the sweep's
 * predicate reads as "never claimed".
 */
function intentRow(input: {
  template: (typeof REQUEST_EXPIRED_TEMPLATES)[number];
  to: string;
  dedupeKey: string;
  requestId: string;
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
 * What the sweep may take: an expiry intent that is still owed and that nobody
 * is currently sending.
 *
 * PENDING only — a FAILED row is settled and is an operator's decision, never
 * this sweep's. Of the PENDING rows, one that has never been claimed, or one
 * whose claim is older than the lease and therefore belongs to a runner that is
 * not coming back.
 */
function claimablePredicate(now: Date): Prisma.NotificationLogWhereInput {
  return {
    template: { in: [...REQUEST_EXPIRED_TEMPLATES] },
    status: NotificationStatus.PENDING,
    OR: [
      { lastAttemptAt: null },
      { lastAttemptAt: { lt: new Date(now.getTime() - EXPIRY_OUTBOX_CLAIM_LEASE_MS) } },
    ],
  };
}
