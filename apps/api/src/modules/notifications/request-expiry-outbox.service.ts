import { Inject, Injectable, Logger } from '@nestjs/common';
import { OfferStatus, Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import {
  deliverPendingIntents,
  INTENT_CLAIM_LEASE_MS,
  IntentDeliveryResult,
  intentRow,
} from './notification-intents';
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
 * moved one step later. The lease itself is shared with every other intent
 * outbox (see notification-intents.ts); this name is kept for the callers and
 * tests that learned it here.
 */
export const EXPIRY_OUTBOX_CLAIM_LEASE_MS = INTENT_CLAIM_LEASE_MS;

/** Intents one sweep may deliver. Matches the job's own scan limit by default. */
const DEFAULT_DELIVERY_LIMIT = 200;

export type ExpiryOutboxDeliveryResult = IntentDeliveryResult;

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
    return deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: REQUEST_EXPIRED_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Request expiry',
    });
  }
}

