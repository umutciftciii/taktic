import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationStatus, Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import {
  DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT,
  REQUEST_EXPIRY_DAYS,
  REQUEST_REMINDER_AFTER_DAYS,
  requestReminderCutoff,
} from './request-lifecycle.constants';

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
    const candidates = await this.prisma.serviceRequest.findMany({
      where: reminderCandidateWhere(cutoff),
      orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        requestNumber: true,
        customerId: true,
        customerName: true,
        customerEmail: true,
        approvedAt: true,
        category: { select: { name: true } },
      },
    });

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
      const offerCount = await this.prisma.offer.count({ where: { requestId: candidate.id } });
      if (offerCount > 0) {
        skipped += 1;
        continue;
      }

      const claim = await this.prisma.serviceRequest.updateMany({
        where: { id: candidate.id, ...reminderClaimWhere(cutoff) },
        data: { reminderSentAt: new Date() },
      });

      if (claim.count !== 1) {
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
            expiresAt: expiryMoment(candidate.approvedAt)?.toISOString() ?? null,
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

function expiryMoment(approvedAt: Date | null): Date | null {
  if (!approvedAt) {
    return null;
  }

  return new Date(approvedAt.getTime() + REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * A request earns the reminder when it has been approved for seven days, has
 * never been reminded, and has no offer at all — not "no recent offer" and not
 * "no open offer": a single withdrawn offer still means the customer heard from
 * somebody, so the reminder would be wrong.
 */
function reminderCandidateWhere(cutoff: Date): Prisma.ServiceRequestWhereInput {
  return {
    ...reminderClaimWhere(cutoff),
    offers: { none: {} },
  };
}

function reminderClaimWhere(cutoff: Date): Prisma.ServiceRequestWhereInput {
  return {
    status: ServiceRequestStatus.APPROVED,
    approvedAt: { not: null, lte: cutoff },
    reminderSentAt: null,
  };
}
