import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { deliverPendingIntents, IntentDeliveryResult, intentRow } from './notification-intents';
import { findMatchingProviders, TransactionalMailService } from './transactional-mail.service';

/**
 * The approval fan-out as a durable intent rather than a synchronous send.
 *
 * The same arrangement as {@link import('./request-expiry-outbox.service').RequestExpiryOutbox}:
 * `enqueue` runs inside the transaction that publishes the request, so "the
 * request is live" and "its notifications are owed" commit together or not at
 * all. `deliverPending` runs after the commit and never on the request path's
 * critical section; anything it does not finish is picked up by the next
 * delivery, by the expiry scheduler's tick, or by the admin retry button —
 * all three keyed on the same (template, dedupeKey) unique index.
 *
 * Delivery re-derives every message from its dedupe key through the same
 * `composeRetryMessage` path the admin re-send uses. The customer's key
 * carries the approval instant (`request-published:<id>:<when>`) because a
 * request can legitimately be published more than once; the provider's key
 * carries the provider (`request-available:<id>:<providerId>`) because one
 * publication owes one invitation per provider. Audience membership is
 * re-checked at send time, so a provider suspended between the enqueue and
 * the sweep gets nothing.
 */

/** The two templates one publication produces, and the only rows this sweep touches. */
export const REQUEST_PUBLISH_TEMPLATES = ['request-published', 'request-available'] as const;

/** Intents one sweep may deliver. Matches the lifecycle jobs' scan limit by default. */
const DEFAULT_DELIVERY_LIMIT = 200;

export type RequestPublishOutboxResult = IntentDeliveryResult;

@Injectable()
export class RequestPublishOutbox implements OnModuleDestroy {
  private readonly logger = new Logger(RequestPublishOutbox.name);

  /**
   * The sweep currently running in this process, if any. Sweeps are
   * serialised per process so that awaiting `deliverPending` means every
   * intent enqueued before the call has been attempted — by the sweep that
   * was already running or by the one this call starts after it. Across
   * processes the row claim is the guard; this is only about the answer a
   * caller in *this* process can rely on.
   */
  private inFlight: Promise<RequestPublishOutboxResult> | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * Writes down every message this publication owes, inside the caller's
   * transaction. Nothing is sent here and no transport is touched.
   *
   * Read after the status update, so it is the transition's own answer: a
   * request that is not live, or one still reserved for a single vitrin
   * business, is fanned out to nobody. `reached` is the whole audience the
   * discovery rules produce — the number the customer's message will quote —
   * and `enqueued` is how many rows this call actually added; the difference
   * on a second call is the unique index doing its job.
   */
  async enqueue(
    tx: Prisma.TransactionClient,
    requestId: string,
    approvedAt: Date,
  ): Promise<{ reached: number; enqueued: number }> {
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        customerId: true,
        customerEmail: true,
        categoryId: true,
        city: true,
        district: true,
        neighborhood: true,
        directShowcaseProviderId: true,
      },
    });

    if (
      !request ||
      request.status !== ServiceRequestStatus.APPROVED ||
      request.directShowcaseProviderId !== null
    ) {
      return { reached: 0, enqueued: 0 };
    }

    const audience = await findMatchingProviders(tx, request);
    const intents: Prisma.NotificationLogCreateManyInput[] = [];

    const customerEmail = request.customerEmail?.trim();
    if (customerEmail) {
      intents.push(
        intentRow({
          template: 'request-published',
          to: customerEmail,
          dedupeKey: `request-published:${request.id}:${approvedAt.toISOString()}`,
          requestId: request.id,
          userId: request.customerId,
          providerId: null,
        }),
      );
    }

    for (const provider of audience) {
      if (!provider.recipient) {
        continue;
      }

      intents.push(
        intentRow({
          template: 'request-available',
          to: provider.recipient,
          dedupeKey: `request-available:${request.id}:${provider.id}`,
          requestId: request.id,
          userId: provider.userId,
          providerId: provider.id,
        }),
      );
    }

    const created =
      intents.length === 0
        ? { count: 0 }
        : await tx.notificationLog.createMany({ data: intents, skipDuplicates: true });

    // Counts and the request id only — no address, no name.
    this.logger.log(
      `request publish intents for ${request.id}: reached=${audience.length} enqueued=${created.count}`,
    );

    return { reached: audience.length, enqueued: created.count };
  }

  /**
   * Delivers the intents that are still owed — this publication's and any
   * earlier one's. Never throws; see `deliverPendingIntents`.
   */
  async deliverPending(options: { limit?: number } = {}): Promise<RequestPublishOutboxResult> {
    // Wait out whatever sweep is running, then run one of our own: a row the
    // earlier sweep scanned before this caller's enqueue is picked up here.
    while (this.inFlight) {
      // Another sweep's failure is its own to report, not this caller's.
      await this.inFlight.catch(() => undefined);
    }

    const sweep = deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: REQUEST_PUBLISH_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Request publish',
    }).finally(() => {
      if (this.inFlight === sweep) {
        this.inFlight = null;
      }
    });
    this.inFlight = sweep;

    return sweep;
  }

  /**
   * A sweep `deliverSoon` started is nobody's to await — except on the way
   * down. Waiting here lets a send that is already talking to the transport
   * finish before the database client goes; a sweep cut off mid-way is still
   * safe (the claim is recorded, the lease expires, the next sweep retries),
   * it is just a slower path than finishing.
   */
  async onModuleDestroy(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /**
   * Fire after a commit: never awaited by a request handler.
   *
   * The response to the customer does not wait on a mail provider, and a
   * failure here is logged rather than surfaced — the rows are still PENDING
   * and the next sweep, on any instance, picks them up.
   */
  deliverSoon(): void {
    void this.deliverPending().catch((error: unknown) => {
      this.logger.error(
        'Request publish delivery failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }
}
