import { Inject, Injectable } from '@nestjs/common';
import { Prisma, ShowcaseLeadCloseReason, ShowcaseLeadStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The two things that happen to a vitrin lead because of something that
 * happened to its request.
 *
 * Both are one conditional UPDATE, both take the caller's transaction client,
 * and both live here — apart from `ShowcaseLeadService` — for a structural
 * reason rather than a stylistic one.
 *
 * `ShowcaseLeadService` creates leads, which means it depends on
 * `ServiceRequestsService`: a lead *is* a request. But the request lifecycle
 * has to call back — cancelling or refusing a request closes its lead, and
 * offering on a direct lead marks it answered — and both of those have to
 * commit with the change that caused them.
 *
 * Putting the call-backs in the same service as the creation would make
 * `ServiceRequestsModule` and `ShowcaseModule` mutually dependent, and the
 * `forwardRef` that papers over that propagates: every module that reaches
 * either one ends up inside the cycle, and Nest resolves one of them to
 * `undefined` at scan time. Splitting the two directions apart is what makes
 * the dependency one-way in each place — this file needs nothing but Prisma,
 * so anybody may hold it.
 *
 * ## Why the state changes belong to vitrin at all
 *
 * They could have been written inline in the request lifecycle. They are not,
 * because "which lead statuses may still be closed" and "what a closure records"
 * are vitrin's rules, and a copy of them in the request module is the copy that
 * goes stale when a status is added.
 */
@Injectable()
export class ShowcaseLeadLifecycleService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Closes the lead attached to a request, in the transaction that closed the
   * request.
   *
   * Called by the moderation refusal and by the customer's own cancellation.
   * Both are decisions about the request, and a lead left OPEN behind one of
   * them would keep an SLA clock running against a business over something
   * nobody can act on any more — and would eventually ask the customer whether
   * to release a request that no longer exists to release.
   *
   * A BREACHED lead is closable as well as an OPEN one: the customer may cancel
   * while the fallback question is still on their screen, and that answers it.
   *
   * Returns quietly for a request with no lead, which is nearly every request.
   */
  async closeForRequest(
    tx: Prisma.TransactionClient,
    requestId: string,
    reason: ShowcaseLeadCloseReason,
    now: Date = new Date(),
  ): Promise<boolean> {
    const closed = await tx.showcaseLead.updateMany({
      where: {
        requestId,
        status: { in: [ShowcaseLeadStatus.OPEN, ShowcaseLeadStatus.BREACHED] },
      },
      data: {
        status: ShowcaseLeadStatus.CLOSED_UNANSWERED,
        closedAt: now,
        closeReason: reason,
      },
    });

    return closed.count > 0;
  }

  /**
   * Records that the card's owner answered, in the transaction that created the
   * offer.
   *
   * The conditional is what settles the race with the breach sweeper: a lead
   * that is no longer OPEN matches nothing, so a provider answering in the last
   * second either beats the sweeper or does not, and the database decides —
   * not the ordering of two background jobs.
   */
  async markAnswered(
    tx: Prisma.TransactionClient,
    requestId: string,
    offerId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const answered = await tx.showcaseLead.updateMany({
      where: { requestId, status: ShowcaseLeadStatus.OPEN },
      data: {
        status: ShowcaseLeadStatus.ANSWERED,
        respondedAt: now,
        respondedOfferId: offerId,
      },
    });

    return answered.count === 1;
  }
}
