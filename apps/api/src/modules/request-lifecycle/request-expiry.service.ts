import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT,
  requestExpiryCutoff,
} from './request-lifecycle.constants';

export type RequestExpiryResult = {
  processed: number;
  expired: number;
  skipped: number;
  failed: number;
};

/**
 * Closes APPROVED requests that have been open for the full 14 days.
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
 */
@Injectable()
export class RequestExpiryService {
  private readonly logger = new Logger(RequestExpiryService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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

    for (const candidate of candidates) {
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
    }

    return { processed: candidates.length, expired, skipped, failed };
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
