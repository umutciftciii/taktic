import { Inject, Injectable, Logger } from '@nestjs/common';
import { MatchRoundStatus, NotificationStatus, Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import {
  DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT,
  REQUEST_EXPIRY_DAYS,
  REQUEST_REMINDER_AFTER_DAYS,
  requestReminderCutoff,
} from './request-lifecycle.constants';
import { claimRoundReminder } from '../match-rounds/match-round-transitions';

export type RequestReminderResult = {
  processed: number;
  reminded: number;
  skipped: number;
  failedToSend: number;
};

const REMINDER_SUBJECT = 'Talebiniz için süre dolmak üzere';

/**
 * Sends the single day-7 reminder to customers whose approved request has not
 * received a single offer yet.
 *
 * REL-002 Faz 2: the clock and the claim are the current **round's** —
 * `publishedAt` and `reminderSentAt` — so each round earns at most one
 * reminder of its own. For Round 1 those are the request's `approvedAt` and
 * `reminderSentAt` (carried by the backfill), so nothing is reminded twice or
 * early across the switch. The request's `reminderSentAt` is still written in
 * the same transaction as a compatibility mirror; nothing reads it to decide.
 *
 * Two properties are load-bearing:
 *
 * 1. **The claim is the guarantee.** `reminderSentAt` is written by a
 *    conditional UPDATE that only matches while the column is still NULL, so
 *    two schedulers racing on the same request produce exactly one claim — the
 *    loser's UPDATE re-evaluates the predicate after the row lock and matches
 *    nothing.
 * 2. **The claim survives a failed send.** Delivery happens after the claim is
 *    committed, and the dispatcher never throws: a transport failure is recorded
 *    as a FAILED NotificationLog row and the request keeps both its status and
 *    its reminder mark. The alternative — releasing the claim — would re-mail
 *    the customer on every run for as long as the transport stays broken.
 */
@Injectable()
export class RequestReminderService {
  private readonly logger = new Logger(RequestReminderService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly notifications: NotificationDispatcher,
  ) {}

  async execute(options: { limit?: number } = {}): Promise<RequestReminderResult> {
    const limit = options.limit ?? DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT;
    const cutoff = requestReminderCutoff();
    const rounds = await this.prisma.serviceRequestMatchRound.findMany({
      where: reminderCandidateWhere(cutoff),
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        expiresAt: true,
        request: {
          select: {
            id: true,
            requestNumber: true,
            customerId: true,
            customerName: true,
            customerEmail: true,
            category: { select: { name: true } },
          },
        },
      },
    });
    const candidates = rounds.map((round) => ({
      ...round.request,
      roundId: round.id,
      expiresAt: round.expiresAt,
    }));

    let reminded = 0;
    let skipped = 0;
    let failedToSend = 0;

    for (const candidate of candidates) {
      const email = candidate.customerEmail?.trim();
      if (!email) {
        // Nothing to send to. The row is left unclaimed rather than marked, so
        // it becomes reachable again the moment an address is recorded.
        skipped += 1;
        continue;
      }

      // Re-checked immediately before the claim so a request that received its
      // first offer between the scan and now is not reminded anyway. This is a
      // narrowing, not the correctness guard — that is the claim below.
      const offerCount = await this.prisma.offer.count({ where: { matchRoundId: candidate.roundId } });
      if (offerCount > 0) {
        skipped += 1;
        continue;
      }

      // The claim is the round's; the request's column is written beside it as
      // a compatibility mirror, conditional on the request still being the
      // APPROVED owner of this round — a request that moved on (matched,
      // cancelled, expired) rolls the claim back and is skipped.
      const claimed = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        if (!(await claimRoundReminder(tx, { roundId: candidate.roundId, cutoff, now }))) {
          return false;
        }
        const mirrored = await tx.serviceRequest.updateMany({
          where: {
            id: candidate.id,
            status: ServiceRequestStatus.APPROVED,
            currentRoundId: candidate.roundId,
          },
          data: { reminderSentAt: now },
        });
        if (mirrored.count !== 1) {
          throw new ReminderClaimAbandoned();
        }
        return true;
      }).catch((error: unknown) => {
        if (error instanceof ReminderClaimAbandoned) {
          return false;
        }
        throw error;
      });

      if (!claimed) {
        skipped += 1;
        continue;
      }

      reminded += 1;

      const outcome = await this.notifications.sendEmail(
        {
          template: 'request-expiring',
          to: email,
          subject: REMINDER_SUBJECT,
          data: {
            // For the salutation. The reminder had no name to greet with while
            // it rendered through the plain renderer, which opened with a bare
            // "Merhaba,"; the design system opens every message with a named
            // salutation, and the request already carries the name.
            fullName: candidate.customerName,
            requestNumber: candidate.requestNumber,
            categoryName: candidate.category.name,
            openDays: String(REQUEST_EXPIRY_DAYS),
            remainingDays: String(REQUEST_EXPIRY_DAYS - REQUEST_REMINDER_AFTER_DAYS),
            expiresAt: candidate.expiresAt?.toISOString() ?? null,
          },
        },
        { requestId: candidate.id, userId: candidate.customerId },
      );

      if (outcome.status === NotificationStatus.FAILED) {
        failedToSend += 1;
        // The claim deliberately stands. NotificationLog is where the failure
        // stays visible; see the class comment.
        this.logger.warn(
          `Reminder for request ${candidate.id} was claimed but not delivered (${outcome.errorCode})`,
        );
      }
    }

    return { processed: candidates.length, reminded, skipped, failedToSend };
  }
}

/** The request moved on between the round claim and its mirror: roll back, skip. */
class ReminderClaimAbandoned extends Error {}

/**
 * A round earns the reminder when it has been published for seven days, has
 * never been reminded, is its APPROVED request's current round, and has no
 * offer at all — not "no recent offer" and not "no open offer": a single
 * withdrawn offer still means the customer heard from somebody, so the
 * reminder would be wrong. Offers of an earlier round do not count: each
 * round is its own offer period.
 */
function reminderCandidateWhere(cutoff: Date): Prisma.ServiceRequestMatchRoundWhereInput {
  return {
    status: MatchRoundStatus.OPEN,
    reminderSentAt: null,
    publishedAt: { not: null, lte: cutoff },
    offers: { none: {} },
    currentForRequest: { some: { status: ServiceRequestStatus.APPROVED } },
  };
}
