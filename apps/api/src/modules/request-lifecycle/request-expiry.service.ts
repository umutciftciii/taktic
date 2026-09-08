import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestExpiryOutbox } from '../notifications/request-expiry-outbox.service';
import {
  DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT,
  requestExpiryCutoff,
} from './request-lifecycle.constants';

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
 * Closes APPROVED requests that have been open for the full 14 days, and tells
 * the people who were waiting on them.
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
    const cutoff = requestExpiryCutoff();
    const candidates = await this.prisma.serviceRequest.findMany({
      where: expiryCandidateWhere(cutoff),
      orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    let expired = 0;
    let skipped = 0;
    let failed = 0;
    let enqueued = 0;

    for (const candidate of candidates) {
      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.serviceRequest.updateMany({
            // Repeating the whole candidate predicate — not just the id — is
            // what makes the transition atomic: PostgreSQL re-evaluates it
            // after taking the row lock, so a request that stopped being
            // APPROVED in the meantime is left exactly as it is.
            where: { id: candidate.id, ...expiryCandidateWhere(cutoff) },
            data: { status: ServiceRequestStatus.EXPIRED, expiredAt: new Date() },
          });

          if (updated.count !== 1) {
            // No transition, so nothing is owed. Returning rather than throwing
            // keeps this a normal outcome: a skipped candidate is the ordinary
            // result of two runners agreeing, not a failure.
            return { expired: false, enqueued: 0 };
          }

          return { expired: true, enqueued: await this.outbox.enqueue(tx, candidate.id) };
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
          `Failed to expire request ${candidate.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { processed: candidates.length, expired, skipped, failed, enqueued };
  }
}

/**
 * `approvedAt: { lte: cutoff }` already excludes NULL — SQL comparisons against
 * NULL are never true — but it is spelled out with `not: null` so the intent
 * survives a future edit: a request with no trustworthy approval time must
 * never be expired on a guessed clock.
 */
function expiryCandidateWhere(cutoff: Date): Prisma.ServiceRequestWhereInput {
  return {
    status: ServiceRequestStatus.APPROVED,
    approvedAt: { not: null, lte: cutoff },
  };
}
