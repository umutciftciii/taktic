import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ShowcasePlacementStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import {
  deliverPendingIntents,
  IntentDeliveryResult,
  intentRow,
} from './notification-intents';
import { recipientFor, TransactionalMailService } from './transactional-mail.service';

/**
 * The durable half of a vitrin run's clock notices: seven days out, three days
 * out, and the end.
 *
 * The same arrangement as {@link import('./request-expiry-outbox.service').RequestExpiryOutbox},
 * and for the same reason. The end-of-run notice is owed by a status
 * transition — ACTIVE → EXPIRED — that the expiry job commits and never
 * revisits, so its intent is written *inside* that transaction and sent
 * afterwards; a process that dies between the two leaves a PENDING row the
 * next tick delivers rather than a run nobody was ever told about.
 *
 * The two reminders are owed by a clock rather than a transition, so there is
 * no transaction to join. They are enqueued by a scan of the runs still on the
 * air whose end falls inside the window, with the unique index on
 * `(template, dedupeKey)` as the only bookkeeping: every tick may re-scan the
 * same runs and `skipDuplicates` turns the second look into nothing.
 *
 * ## What the reminders read
 *
 * The run's **current** `endAt`. A suspension that stops the clock moves the
 * end forward when the run resumes, and the scan is against that moved value —
 * so a run pulled by the platform in its second week is reminded seven days
 * before the end it actually gets, not the end it was sold. A suspended run is
 * not ACTIVE and is not scanned at all: whether it comes back, and when, is
 * not yet known.
 *
 * ## Once per threshold, per run
 *
 * The dedupe key is the placement id under the threshold's own template, so a
 * run that is extended *after* its seven-day notice went out is not reminded
 * at seven days again. It is still reminded at three, and told when it ends.
 *
 * ## Why a short run is not reminded of a window it never had
 *
 * A package sold for five days would otherwise receive "seven days left" on
 * its first tick. The seven-day reminder is only owed by a run that lasted
 * longer than seven days, and the three-day one by a run longer than three.
 *
 * ## The order of the two windows
 *
 * A run that reaches the three-day window without a seven-day notice — because
 * the job was off, or the run was suspended across the boundary — receives the
 * three-day notice alone. Sending both at once would be two messages saying
 * different numbers about one clock.
 */

/** The three clock notices, and the only rows this sweep touches. */
export const SHOWCASE_LIFECYCLE_TEMPLATES = [
  'showcase-placement-ending-7d',
  'showcase-placement-ending-3d',
  'showcase-placement-expired',
] as const;

/** The two reminder thresholds, in days before the end. */
export const SHOWCASE_REMINDER_DAYS = { first: 7, second: 3 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Intents one sweep may deliver. Matches the job's own scan limit by default. */
const DEFAULT_DELIVERY_LIMIT = 200;

export type ShowcaseLifecycleOutboxResult = IntentDeliveryResult;

@Injectable()
export class ShowcaseLifecycleOutbox {
  private readonly logger = new Logger(ShowcaseLifecycleOutbox.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * Writes down the end-of-run notice, inside the caller's transaction.
   *
   * Takes the transaction client so the intent and the `→ EXPIRED` update
   * commit together or not at all. Read after the update, so it is the
   * transition's own answer: a candidate another runner took, or an update
   * that matched nothing, produces no intent without anybody having to check.
   *
   * Nothing is sent here and no transport is touched.
   */
  async enqueueExpired(tx: Prisma.TransactionClient, placementId: string): Promise<number> {
    const placement = await tx.showcasePlacement.findUnique({
      where: { id: placementId },
      select: {
        id: true,
        status: true,
        providerId: true,
        provider: { select: { userId: true, email: true, user: { select: { email: true } } } },
      },
    });

    if (!placement || placement.status !== ShowcasePlacementStatus.EXPIRED) {
      return 0;
    }

    const recipient = recipientFor(placement.provider);
    if (!recipient) {
      return 0;
    }

    const created = await tx.notificationLog.createMany({
      data: [
        intentRow({
          template: 'showcase-placement-expired',
          to: recipient,
          dedupeKey: `showcase-placement-expired:${placement.id}`,
          requestId: null,
          userId: placement.provider.userId,
          providerId: placement.providerId,
        }),
      ],
      skipDuplicates: true,
    });

    return created.count;
  }

  /**
   * Writes down the reminders owed by every run on the air whose end falls
   * inside a window.
   *
   * Two scans, one per threshold, each bounded by the caller's limit and each
   * followed by one `createMany` with `skipDuplicates`. Re-running it is free
   * by construction: a run already reminded collides on the unique index and
   * writes nothing.
   *
   * The seven-day scan excludes the three-day window and the three-day scan
   * excludes nothing above it, which is what makes "the three-day notice
   * alone" the outcome for a run that arrives late (see the class comment).
   */
  async enqueueEndingReminders(
    now: Date,
    options: { limit?: number } = {},
  ): Promise<{ first: number; second: number }> {
    const limit = options.limit ?? DEFAULT_DELIVERY_LIMIT;
    const { first, second } = SHOWCASE_REMINDER_DAYS;

    return {
      first: await this.enqueueReminder(
        'showcase-placement-ending-7d',
        {
          gt: new Date(now.getTime() + second * DAY_MS),
          lte: new Date(now.getTime() + first * DAY_MS),
        },
        first,
        limit,
      ),
      second: await this.enqueueReminder(
        'showcase-placement-ending-3d',
        { gt: now, lte: new Date(now.getTime() + second * DAY_MS) },
        second,
        limit,
      ),
    };
  }

  private async enqueueReminder(
    template: 'showcase-placement-ending-7d' | 'showcase-placement-ending-3d',
    endAt: { gt: Date; lte: Date },
    daysLeft: number,
    limit: number,
  ): Promise<number> {
    const candidates = await this.prisma.showcasePlacement.findMany({
      where: {
        status: ShowcasePlacementStatus.ACTIVE,
        endAt,
        // A run shorter than the window never had the days this notice
        // counts down, so it is not reminded of them.
        durationDaysSnapshot: { gt: daysLeft },
      },
      orderBy: [{ endAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        providerId: true,
        provider: { select: { userId: true, email: true, user: { select: { email: true } } } },
      },
    });

    const intents: Prisma.NotificationLogCreateManyInput[] = [];

    for (const placement of candidates) {
      const recipient = recipientFor(placement.provider);
      if (!recipient) {
        continue;
      }

      intents.push(
        intentRow({
          template,
          to: recipient,
          dedupeKey: `${template}:${placement.id}`,
          requestId: null,
          userId: placement.provider.userId,
          providerId: placement.providerId,
        }),
      );
    }

    if (intents.length === 0) {
      return 0;
    }

    const created = await this.prisma.notificationLog.createMany({
      data: intents,
      skipDuplicates: true,
    });

    return created.count;
  }

  /**
   * Delivers the intents that are still owed — this tick's and any earlier
   * tick's. One pass, run at the end of every placement-expiry tick, and the
   * only thing that ever sends these three messages.
   */
  async deliverPending(options: { limit?: number } = {}): Promise<ShowcaseLifecycleOutboxResult> {
    return deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: SHOWCASE_LIFECYCLE_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Vitrin lifecycle',
    });
  }
}
