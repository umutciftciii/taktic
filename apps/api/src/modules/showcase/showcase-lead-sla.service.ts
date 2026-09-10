import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ServiceRequestStatus,
  ShowcaseLeadCloseReason,
  ShowcaseLeadStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  DEFAULT_SHOWCASE_SCAN_LIMIT,
  showcaseFallbackTimeoutCutoff,
} from './showcase.constants';

export type ShowcaseLeadSlaResult = {
  /** Leads whose deadline passed and which this run claimed. */
  breached: number;
  /** Candidates a rival runner, a late answer or a cancellation had moved. */
  skipped: number;
  /** Breached leads the customer never answered, closed by the timeout. */
  timedOut: number;
  /** Fallback questions this run actually put in front of somebody. */
  notified: number;
  failed: number;
};

/**
 * The two arms of the direct-lead clock.
 *
 * ## Arm one — the deadline passed
 *
 * A lead whose `slaDueAt` is behind us and which is still OPEN becomes
 * BREACHED, and the customer is asked what they want to do.
 *
 * **A breach opens nothing on its own.** The lead does not go to the market,
 * the gate is not cleared and no other business learns the request exists. The
 * customer wrote to one company; deciding that a missed deadline hands their
 * request to every company in the district is not a decision this application
 * gets to make. `ShowcaseLead_release_needs_decision` says the same thing at
 * the database level: a `releasedAt` cannot be stored without the customer's
 * RELEASE on the same row.
 *
 * The claim is a conditional UPDATE on `status = 'OPEN' AND slaDueAt <= now`.
 * That is the whole of the concurrency design, and it settles two races at
 * once: two runners find one row and only one of them changes it, and a card
 * owner who answered at the last second has already moved the row to ANSWERED,
 * so the sweeper matches nothing. The database decides, not the ordering.
 *
 * ## Arm two — the customer never answered
 *
 * A breached lead sitting with no decision closes itself after fourteen days,
 * and the request is cancelled with it.
 *
 * This arm exists because of a gap that would otherwise be permanent. A direct
 * lead starts at SUBMITTED, and the ordinary expiry sweeper only reads APPROVED
 * rows — so an unanswered lead would hang at SUBMITTED for ever, invisible to
 * every clock in the product. Fourteen days is the window an approved request
 * already gets, deliberately: one window to explain, not two.
 *
 * The outcome is `CLOSED_UNANSWERED`, never a release. Silence is not consent
 * to publish somebody's request.
 *
 * ## Why this runs at all only when a person says so
 *
 * Both arms are behind `showcaseLeadSlaSchedulerEnabled`, read fail-closed on
 * every tick like the other four jobs. A fresh deployment breaches nothing
 * until an operator opens the screen.
 */
@Injectable()
export class ShowcaseLeadSlaService {
  private readonly logger = new Logger(ShowcaseLeadSlaService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  async execute(options: { limit?: number } = {}): Promise<ShowcaseLeadSlaResult> {
    const limit = options.limit ?? DEFAULT_SHOWCASE_SCAN_LIMIT;
    const breaches = await this.breachDueLeads(limit);
    const timeouts = await this.closeAbandonedLeads(limit);

    return { ...breaches, timedOut: timeouts.closed };
  }

  /** Arm one. */
  async breachDueLeads(limit = DEFAULT_SHOWCASE_SCAN_LIMIT) {
    const now = new Date();
    const candidates = await this.prisma.showcaseLead.findMany({
      where: { status: ShowcaseLeadStatus.OPEN, slaDueAt: { lte: now } },
      orderBy: [{ slaDueAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    let breached = 0;
    let skipped = 0;
    let notified = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        // Repeating the whole predicate rather than just the id is what makes
        // the claim atomic: PostgreSQL re-evaluates it after taking the row
        // lock, so a lead that stopped being OPEN in the meantime is left
        // exactly as it is.
        const claimed = await this.prisma.showcaseLead.updateMany({
          where: { id: candidate.id, status: ShowcaseLeadStatus.OPEN, slaDueAt: { lte: now } },
          data: {
            status: ShowcaseLeadStatus.BREACHED,
            breachedAt: now,
            fallbackAskedAt: now,
          },
        });

        if (claimed.count !== 1) {
          skipped += 1;
          continue;
        }

        breached += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `vitrin lead ${candidate.id} could not be breached`,
          error instanceof Error ? error.stack : String(error),
        );
        continue;
      }

      /*
       * The question, after the claim has committed.
       *
       * Outside the transaction for the reason every other notification in this
       * codebase is: the state change is the fact, and a mail transport that is
       * down must not roll back a deadline that really did pass. The dedupe key
       * on (template, dedupeKey) means a later run cannot ask twice.
       *
       * Asked **once**. There is no reminder: the fourteen-day timeout already
       * treats silence as an answer, and chasing somebody for a decision they
       * have chosen not to make is not a decision this product needs from them.
       */
      try {
        await this.mail.sendShowcaseLeadBreached(candidate.id);
        notified += 1;
      } catch (error) {
        this.logger.error(
          `vitrin lead ${candidate.id} fallback question could not be sent`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { breached, skipped, notified, failed };
  }

  /** Arm two. */
  async closeAbandonedLeads(limit = DEFAULT_SHOWCASE_SCAN_LIMIT) {
    const now = new Date();
    const cutoff = showcaseFallbackTimeoutCutoff(now);

    const candidates = await this.prisma.showcaseLead.findMany({
      where: {
        status: ShowcaseLeadStatus.BREACHED,
        fallbackDecidedAt: null,
        breachedAt: { lte: cutoff },
      },
      orderBy: [{ breachedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, requestId: true },
    });

    let closed = 0;

    for (const candidate of candidates) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const moved = await tx.showcaseLead.updateMany({
          where: {
            id: candidate.id,
            status: ShowcaseLeadStatus.BREACHED,
            fallbackDecidedAt: null,
            breachedAt: { lte: cutoff },
          },
          data: {
            status: ShowcaseLeadStatus.CLOSED_UNANSWERED,
            closedAt: now,
            closeReason: ShowcaseLeadCloseReason.REQUEST_EXPIRED,
          },
        });

        if (moved.count !== 1) {
          return false;
        }

        // `fallbackDecision` is deliberately left NULL. The customer made no
        // decision, and writing KEEP_CLOSED here would put words in their mouth
        // — the close reason already says what actually happened.
        await tx.serviceRequest.updateMany({
          where: { id: candidate.requestId, status: ServiceRequestStatus.SUBMITTED },
          data: { status: ServiceRequestStatus.CANCELLED, cancelledAt: now },
        });

        return true;
      });

      if (outcome) {
        closed += 1;
      }
    }

    return { closed };
  }
}
