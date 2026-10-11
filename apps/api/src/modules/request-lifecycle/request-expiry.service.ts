import { Inject, Injectable, Logger } from '@nestjs/common';
import { MatchRoundStatus, Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestExpiryOutbox } from '../notifications/request-expiry-outbox.service';
import { DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT } from './request-lifecycle.constants';
import { transitionRoundToExpired } from '../match-rounds/match-round-transitions';

export type RequestExpiryResult = {
  processed: number;
  expired: number;
  skipped: number;
  failed: number;
  /** Notification intents written alongside the transitions this run made. */
  enqueued: number;
  /** Messages actually delivered by this run's sweep — this tick's and older. */
  notified: number;
};

/**
 * Closes APPROVED requests whose current match round has been open for the
 * full 14 days, and tells the people who were waiting on them.
 *
 * REL-002 Faz 2: the clock is the **round's** — `publishedAt`, and the
 * `expiresAt` snapshot taken when it was published. For Round 1 that is the
 * request's `approvedAt` (+14 days), so a request expires at exactly the
 * moment it always did; a later round starts its own fourteen days. The round
 * and the request expire together, in one transaction.
 *
 * This is the only writer of ServiceRequestStatus.EXPIRED — the admin
 * moderation endpoint refuses it by design, so an expired request is always a
 * clock decision and never a human one.
 *
 * Idempotency is structural rather than bookkeeping: every row is closed by a
 * conditional UPDATE that still requires status = 'APPROVED'. A row that a
 * concurrent run, an offer accept (MATCHED), a cancellation or a completion has
 * already moved matches nothing and is counted as skipped. Running the job
 * twice over the same candidate set therefore changes exactly one row once.
 *
 * # The two phases, and why they are two
 *
 * A tick does the transitions, then sweeps the outbox. They are separate
 * because they answer to different failures.
 *
 * **Phase one — expire and record what is owed.** The conditional UPDATE and
 * the notification intents commit in one transaction. That is the durability
 * property this job used to lack: the messages used to be composed *after* the
 * commit, so a process that died in between left an expired request that no
 * later run could notice — the candidate query only looks at APPROVED rows, so
 * the request was permanently past the one thing that would have mailed
 * anybody, with no record that a message had ever been owed. Now the record
 * commits with the transition or not at all.
 *
 * **Phase two — deliver what is owed.** A sweep over PENDING intents, this
 * tick's and every earlier tick's. It runs whether or not phase one expired
 * anything, which is the whole point: a tick that finds no candidates is
 * exactly the tick that has to notice the intents an interrupted run left
 * behind. Delivery claims each row conditionally, so two API instances
 * sweeping at once send once, and it never retries a FAILED row — that stays
 * an operator's decision, as it is for every other message here.
 *
 * A transport failure therefore cannot reach the transition: by the time
 * anything is sent, the status is committed and out of this method's hands.
 * And a message cannot exist for a transition that did not happen, because the
 * intents are written by the same transaction that made it.
 */
@Injectable()
export class RequestExpiryService {
  private readonly logger = new Logger(RequestExpiryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestExpiryOutbox) private readonly outbox: RequestExpiryOutbox,
  ) {}

  /**
   * One natural tick: expire what is due, then deliver what is owed.
   *
   * The only caller in the running system is the scheduler. The two phases are
   * separately callable because they are separately meaningful — and because a
   * test that has to reproduce "the process died after the commit" needs to be
   * able to stop between them without a fake clock or a killed process.
   */
  async execute(options: { limit?: number } = {}): Promise<RequestExpiryResult> {
    const limit = options.limit ?? DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT;
    const transitions = await this.expireDueRequests({ limit });
    const delivery = await this.outbox.deliverPending({ limit });

    return { ...transitions, notified: delivery.sent };
  }

  /**
   * Phase one. Expires each due request and writes down, in the same
   * transaction, every message that expiry owes.
   *
   * Read Committed rather than Serializable, deliberately: the guard is the
   * conditional UPDATE, which PostgreSQL re-evaluates after taking the row
   * lock. A second runner's UPDATE matches nothing and its transaction writes
   * no intents, so there is no anomaly a stricter level would prevent.
   */
  async expireDueRequests(
    options: { limit?: number } = {},
  ): Promise<Omit<RequestExpiryResult, 'notified'>> {
    const limit = options.limit ?? DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT;
    const now = new Date();
    // Rounds, not requests: the scan walks the (status, expiresAt) index.
    const candidates = await this.prisma.serviceRequestMatchRound.findMany({
      where: expiryCandidateWhere(now),
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, requestId: true },
    });

    let expired = 0;
    let skipped = 0;
    let failed = 0;
    let enqueued = 0;

    for (const candidate of candidates) {
      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          const expiredAt = new Date();
          // The request first — the same order an acceptance writes in — and
          // conditional on everything that has to still be true: APPROVED,
          // unmatched and still on this round. PostgreSQL re-evaluates it after
          // taking the row lock, so a request an acceptance, a cancel or a
          // moderation step moved in the meantime is left exactly as it is.
          const updated = await tx.serviceRequest.updateMany({
            where: {
              id: candidate.requestId,
              status: ServiceRequestStatus.APPROVED,
              matchedOfferId: null,
              currentRoundId: candidate.id,
            },
            data: { status: ServiceRequestStatus.EXPIRED, expiredAt },
          });

          if (updated.count !== 1) {
            // No transition, so nothing is owed. Returning rather than throwing
            // keeps this a normal outcome: a skipped candidate is the ordinary
            // result of two runners agreeing, not a failure.
            return { expired: false, enqueued: 0 };
          }

          // The round expires with it, same expiredAt, conditional on OPEN
          // with no winner; a disagreement throws and rolls both back.
          await transitionRoundToExpired(tx, { roundId: candidate.id, expiredAt });

          return { expired: true, enqueued: await this.outbox.enqueue(tx, candidate.requestId) };
        });

        if (outcome.expired) {
          expired += 1;
          enqueued += outcome.enqueued;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        // The transaction rolled back, so the request is still APPROVED and
        // still a candidate: the next tick tries again, and no half-expired
        // request with no intents behind it can exist.
        //
        // Only the request id and the error class: a request row carries the
        // customer's name, phone and address.
        this.logger.error(
          `Failed to expire request ${candidate.requestId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { processed: candidates.length, expired, skipped, failed, enqueued };
  }
}

/**
 * An OPEN round whose offer period has run out, and which is its request's
 * current round on an APPROVED request. `expiresAt: { lte }` already excludes
 * NULL, but `publishedAt: { not: null }` is spelled out so the intent survives
 * a future edit: a round with no trustworthy publication time (a legacy NULL
 * `approvedAt`) must never be expired on a guessed clock.
 */
function expiryCandidateWhere(now: Date): Prisma.ServiceRequestMatchRoundWhereInput {
  return {
    status: MatchRoundStatus.OPEN,
    publishedAt: { not: null },
    expiresAt: { not: null, lte: now },
    currentForRequest: { some: { status: ServiceRequestStatus.APPROVED } },
  };
}
