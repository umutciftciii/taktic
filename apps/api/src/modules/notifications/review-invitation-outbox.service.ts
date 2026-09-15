import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { deliverPendingIntents, IntentDeliveryResult, intentRow } from './notification-intents';
import { readProviderReviewsEnabled, TransactionalMailService } from './transactional-mail.service';

/**
 * The review invitation as a durable intent rather than a synchronous send.
 *
 * The same arrangement as {@link import('./request-publish-outbox.service').RequestPublishOutbox}:
 * `enqueue` runs inside the transaction that completes the request, so "the
 * job is finished" and "the customer is owed an invitation" commit together
 * or not at all. `deliverPending` runs after the commit and never on the
 * request path's critical section; anything it does not finish is picked up
 * by the next delivery, by the request-expiry scheduler's tick, or by the
 * admin retry button — all three keyed on the same (template, dedupeKey)
 * unique index.
 *
 * Delivery re-derives the message from its dedupe key through the same
 * `composeRetryMessage` path the admin re-send uses. The key is
 * `review-invitation:<requestId>` with no timestamp: a request is completed
 * once, so one request owes at most one invitation. Whether the invitation is
 * still worth sending — the job still COMPLETED, the window still open, no
 * review written yet, the feature still on — is re-checked at send time.
 */

/** The one template a completion produces, and the only rows this sweep touches. */
export const REVIEW_INVITATION_TEMPLATES = ['review-invitation'] as const;

/** Intents one sweep may deliver. Matches the lifecycle jobs' scan limit by default. */
const DEFAULT_DELIVERY_LIMIT = 200;

export type ReviewInvitationOutboxResult = IntentDeliveryResult;

@Injectable()
export class ReviewInvitationOutbox implements OnModuleDestroy {
  private readonly logger = new Logger(ReviewInvitationOutbox.name);

  /**
   * The sweep currently running in this process, if any. Sweeps are
   * serialised per process so that awaiting `deliverPending` means every
   * intent enqueued before the call has been attempted — by the sweep that
   * was already running or by the one this call starts after it. Across
   * processes the row claim is the guard; this is only about the answer a
   * caller in *this* process can rely on.
   */
  private inFlight: Promise<ReviewInvitationOutboxResult> | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * Writes down the invitation this completion owes, inside the caller's
   * transaction. Nothing is sent here and no transport is touched.
   *
   * Read after the status update, so it is the transition's own answer: a
   * request that is not COMPLETED, or one with no address to write to, owes
   * nothing. With the feature switched off nothing is written either — there
   * is no backlog of invitations waiting for the switch to flip, because a
   * customer who finished a job weeks ago is not the one to invite.
   *
   * `completedAt` is accepted so a later version can carry the instant in the
   * key without changing the call sites; v1 does not, since a request is
   * completed exactly once.
   */
  async enqueue(
    tx: Prisma.TransactionClient,
    requestId: string,
    _completedAt: Date,
  ): Promise<{ enqueued: number }> {
    if (!(await readProviderReviewsEnabled(tx))) {
      return { enqueued: 0 };
    }

    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: { id: true, status: true, customerId: true, customerEmail: true },
    });

    const to = request?.customerEmail?.trim();
    if (!request || request.status !== ServiceRequestStatus.COMPLETED || !to) {
      return { enqueued: 0 };
    }

    const created = await tx.notificationLog.createMany({
      data: [
        intentRow({
          template: 'review-invitation',
          to,
          dedupeKey: `review-invitation:${request.id}`,
          requestId: request.id,
          userId: request.customerId,
          providerId: null,
        }),
      ],
      skipDuplicates: true,
    });

    // The count and the request id only — no address, no name.
    this.logger.log(`review invitation intent for ${request.id}: enqueued=${created.count}`);

    return { enqueued: created.count };
  }

  /**
   * Delivers the invitations that are still owed — this completion's and any
   * earlier one's. Never throws; see `deliverPendingIntents`.
   */
  async deliverPending(options: { limit?: number } = {}): Promise<ReviewInvitationOutboxResult> {
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
      templates: REVIEW_INVITATION_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Review invitation',
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
   * failure here is logged rather than surfaced — the row is still PENDING
   * and the next sweep, on any instance, picks it up.
   */
  deliverSoon(): void {
    void this.deliverPending().catch((error: unknown) => {
      this.logger.error(
        'Review invitation delivery failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }
}
