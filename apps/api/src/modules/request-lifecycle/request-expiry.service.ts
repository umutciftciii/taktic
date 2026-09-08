import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT,
  requestExpiryCutoff,
} from './request-lifecycle.constants';

export type RequestExpiryResult = {
  processed: number;
  expired: number;
  skipped: number;
  failed: number;
  /** Messages actually delivered for the requests this run closed. */
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
 * **The notification boundary.** Messages are produced only for a transition
 * this run actually made, and only after that transition has committed — the
 * `updateMany` above is its own transaction, so by the time the mail service is
 * called the request is EXPIRED for everybody. That ordering is what makes the
 * two halves independent in the right direction:
 *
 * - a failed send can never undo an expiry. The mail service swallows its own
 *   failures and the dispatcher records them as FAILED audit rows, and even a
 *   thrown error here is caught and counted rather than allowed to reach the
 *   status write, which has already happened.
 * - a message cannot be produced for an expiry that did not happen. Nothing is
 *   sent for `count !== 1`, and the mail service re-reads the status before it
 *   composes anything.
 *
 * What the ordering deliberately does *not* claim is a distributed transaction.
 * A process killed between the commit and the send leaves an expired request
 * whose notice was never composed; the dispatcher's audit row is written before
 * the transport is called, so a crash *during* a send still leaves a PENDING
 * trace rather than silence. That is the same at-most-once contract every other
 * post-commit message in this system has, and the dedupe keys are what make a
 * re-run safe rather than duplicative.
 */
@Injectable()
export class RequestExpiryService {
  private readonly logger = new Logger(RequestExpiryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  async execute(options: { limit?: number } = {}): Promise<RequestExpiryResult> {
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
    let notified = 0;

    for (const candidate of candidates) {
      let closed = false;

      try {
        const updated = await this.prisma.serviceRequest.updateMany({
          // Repeating the whole candidate predicate — not just the id — is what
          // makes the transition atomic: PostgreSQL re-evaluates it after taking
          // the row lock, so a request that stopped being APPROVED in the
          // meantime is left exactly as it is.
          where: { id: candidate.id, ...expiryCandidateWhere(cutoff) },
          data: { status: ServiceRequestStatus.EXPIRED, expiredAt: new Date() },
        });

        if (updated.count === 1) {
          expired += 1;
          closed = true;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        // Only the request id and the error class: a request row carries the
        // customer's name, phone and address.
        this.logger.error(
          `Failed to expire request ${candidate.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      if (!closed) {
        continue;
      }

      // Its own try/catch, and outside the counter above on purpose: the
      // transition has committed and is not in doubt, so a message that could
      // not be composed must not be reported as a failed expiry.
      try {
        const outcome = await this.mail.sendRequestExpired(candidate.id);
        notified += outcome.notified;
      } catch (error) {
        this.logger.error(
          `Failed to notify for expired request ${candidate.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { processed: candidates.length, expired, skipped, failed, notified };
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
