import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { maskEmail } from '../notifications/mask';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  notificationLogSelect,
  toSafeNotificationLog,
  type SafeNotificationLog,
} from './notification-log.projection';
import {
  NOTIFICATION_RETRY_BLOCK_LABELS,
  notificationRetryEligibility,
} from './notification-retry.rules';

/**
 * The manual re-send of one failed transactional e-mail.
 *
 * Every property this operation needs is a consequence of one decision: a retry
 * acts on an existing audit row and creates no notification identity of its
 * own. There is no new log row, no new dedupeKey and no second entry in the
 * unique index — so "one message per real state transition" is as true after a
 * retry as before it, and the audit trail still has exactly one line per
 * message with the attempt count on it.
 *
 * The four things that make it safe, in the order they happen:
 *
 * 1. **Eligibility is decided from the row, not the request.** The endpoint
 *    takes a log id and nothing else: no recipient, no template, no body. What
 *    may be re-sent is {@link notificationRetryEligibility}'s answer.
 * 2. **The attempt is claimed atomically.** FAILED → PENDING happens in one
 *    conditional update, so a double click, two operators, or two API instances
 *    produce exactly one send and the losers are told so.
 * 3. **The payload is rebuilt server-side.** From live, authoritative domain
 *    data, through the same builders the first attempt used, with the same
 *    guards re-applied — including contact disclosure, which is re-read rather
 *    than assumed.
 * 4. **The rebuilt recipient must still mask to the recorded one.** The row
 *    holds only a mask, and that is enough to refuse a send that would go
 *    somewhere other than where the original was addressed.
 *
 * There is no queue and no scheduler behind this. It runs once, when an
 * operator asks.
 */
@Injectable()
export class NotificationRetryService {
  private readonly logger = new Logger('NotificationRetry');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  async retryNotification(id: string): Promise<SafeNotificationLog> {
    const row = await this.prisma.notificationLog.findUnique({
      where: { id },
      select: notificationLogSelect,
    });

    if (!row) {
      throw new NotFoundException('Notification log not found');
    }

    const eligibility = notificationRetryEligibility(row);

    // The permanent refusals, and only those: this row will never be retryable,
    // whatever happens next. The same sentence the screen shows, so an operator
    // who reached the endpoint another way reads the same rule.
    if (!eligibility.retryable && eligibility.block !== 'STATUS_NOT_FAILED') {
      throw new BadRequestException(NOTIFICATION_RETRY_BLOCK_LABELS[eligibility.block]);
    }

    // Whether the row is *currently* failed is deliberately not decided here.
    // Reading it and then acting on it is a race whose losing side is a
    // duplicate e-mail, so the conditional update below is the only check —
    // "already sent", "already being retried" and "another click won" become
    // one answer instead of three timing-dependent ones.

    // The claim. `updateMany` with the status in the predicate is what makes
    // this atomic: PostgreSQL applies the row lock, and a second caller — the
    // second click, the second tab, the second instance — matches nothing and
    // gets a conflict instead of a send. The attempt is counted here rather
    // than on completion so a crash mid-send still leaves the attempt recorded.
    const claim = await this.prisma.notificationLog.updateMany({
      where: { id, status: NotificationStatus.FAILED },
      data: {
        status: NotificationStatus.PENDING,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        errorCode: null,
        failedAt: null,
      },
    });

    if (claim.count !== 1) {
      throw new ConflictException(
        'Bu bildirim için bir yeniden gönderim zaten sürüyor veya kayıt artık başarısız durumda değil.',
      );
    }

    const message = await this.mail.composeRetryMessage(row.template, row.dedupeKey);

    // The rebuilt address has to be the recorded one. The raw address was never
    // stored, but the mask is a strong enough statement: a message that would
    // now go to a different person is not a retry of this row, and a source
    // whose recipient changed hands is exactly the case this must refuse.
    if (!message || maskEmail(message.to) !== row.maskedRecipient) {
      this.logger.warn(
        `[${row.template}] retry refused for ${row.maskedRecipient}: SOURCE_UNAVAILABLE`,
      );
      return this.recordUnavailable(id);
    }

    await this.dispatcher.resendExistingEmail(id, message, row.maskedRecipient);

    return this.reload(id);
  }

  /**
   * Puts the row back to FAILED with the class that says why, rather than
   * leaving it PENDING. Nothing about the source is recorded — which row is
   * gone is a fact about the domain, not about this message.
   */
  private async recordUnavailable(id: string): Promise<SafeNotificationLog> {
    await this.prisma.notificationLog.update({
      where: { id },
      data: {
        status: NotificationStatus.FAILED,
        failedAt: new Date(),
        errorCode: 'SOURCE_UNAVAILABLE',
      },
    });

    return this.reload(id);
  }

  private async reload(id: string): Promise<SafeNotificationLog> {
    const row = await this.prisma.notificationLog.findUnique({
      where: { id },
      select: notificationLogSelect,
    });

    if (!row) {
      throw new NotFoundException('Notification log not found');
    }

    return toSafeNotificationLog(row);
  }
}
