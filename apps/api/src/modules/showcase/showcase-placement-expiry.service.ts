import { Inject, Injectable, Logger } from '@nestjs/common';
import { ShowcasePlacementStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ShowcaseLifecycleOutbox,
  ShowcaseLifecycleOutboxResult,
} from '../notifications/showcase-lifecycle-outbox.service';
import { ShowcaseEntitlementService } from './showcase-entitlement.service';
import { DEFAULT_SHOWCASE_SCAN_LIMIT } from './showcase.constants';

export type ShowcasePlacementExpiryResult = {
  expired: number;
  skipped: number;
  shelvesClosed: number;
  entitlementsExpired: number;
  /** Reminder intents this tick wrote down, per threshold. */
  remindersEnqueued: { first: number; second: number };
  /** What the lifecycle outbox delivered at the end of the tick. */
  notices: ShowcaseLifecycleOutboxResult;
};

/**
 * Closes vitrin runs whose paid time is up.
 *
 * ## Why this job is an optimisation rather than a guarantee
 *
 * Nothing depends on it having run. Every publish path — the feed, the single
 * card page, the lead endpoint — asks `startAt <= now < endAt` for itself, so a
 * sweeper that has been switched off for a week cannot leave one extra card on
 * the home page for one extra minute. This is the same arrangement
 * `isEntitlementUsable` has with the entitlement sweeper, and it is why a
 * background job that moves nothing but a status can be safely operator-gated.
 *
 * What the job is *for* is everything downstream of the row rather than the
 * page: the provider's own list saying "ended" instead of "active", the
 * operator's filters, and the partial unique index on live placements letting
 * go of the card so its owner can buy the next run.
 *
 * ## Idempotency
 *
 * A conditional UPDATE that still requires the row to be ACTIVE or SUSPENDED
 * and still past its end. Two runners agree by construction; the loser matches
 * nothing and is counted as skipped.
 *
 * ## Why a suspended run also expires
 *
 * A run that was taken off the air and never resumed still ends when its paid
 * time ends. Leaving it SUSPENDED for ever would hold the card's live slot
 * open indefinitely and stop the provider from buying another one — a
 * suspension that outlived the run it suspended.
 *
 * ## Why this job also sweeps stale rights
 *
 * `execute()` finishes by calling `ShowcaseEntitlementService.expireStale`
 * with the same clock and scan limit. Two independent sweepers on the same
 * cron would either double the operator's job list for no reason or drift out
 * of sync with each other; one call here keeps both counts in one log line
 * and one operations-settings toggle.
 *
 * ## Why this job also owns the run's notices
 *
 * The seven-day and three-day reminders and the end-of-run notice are the
 * same clock this job already reads, so they live under the same
 * operations-settings toggle rather than a seventh one: an operator who has
 * switched the run's clock off has switched off everything the clock says. A
 * separate toggle would allow "remind about an end nobody will close" — a
 * state with no honest sentence for the provider. The toggle's default is
 * off, as every job's is, and the audit trail and the admin screen are
 * unchanged.
 *
 * The end-of-run intent is written inside the expiring transaction; the
 * reminders are enqueued by a scan; both are delivered by the outbox at the
 * end of the tick. See `ShowcaseLifecycleOutbox` for why the message and the
 * transition are kept apart.
 */
@Injectable()
export class ShowcasePlacementExpiryService {
  private readonly logger = new Logger(ShowcasePlacementExpiryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcaseEntitlementService) private readonly entitlements: ShowcaseEntitlementService,
    @Inject(ShowcaseLifecycleOutbox) private readonly outbox: ShowcaseLifecycleOutbox,
  ) {}

  async execute(options: { limit?: number } = {}): Promise<ShowcasePlacementExpiryResult> {
    const limit = options.limit ?? DEFAULT_SHOWCASE_SCAN_LIMIT;
    const now = new Date();

    const candidates = await this.prisma.showcasePlacement.findMany({
      where: {
        status: {
          in: [ShowcasePlacementStatus.ACTIVE, ShowcasePlacementStatus.SUSPENDED],
        },
        endAt: { lte: now },
      },
      orderBy: [{ endAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    let expired = 0;
    let skipped = 0;
    let shelvesClosed = 0;

    for (const candidate of candidates) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const moved = await tx.showcasePlacement.updateMany({
          where: {
            id: candidate.id,
            status: {
              in: [ShowcasePlacementStatus.ACTIVE, ShowcasePlacementStatus.SUSPENDED],
            },
            endAt: { lte: now },
          },
          data: {
            status: ShowcasePlacementStatus.EXPIRED,
            suspendedAt: null,
            suspendReason: null,
          },
        });

        if (moved.count !== 1) {
          return { expired: false, shelves: 0 };
        }

        // An open suspension is closed with the run rather than left hanging:
        // `endAtAfter` records where the clock actually stopped, and the
        // partial unique index on open suspensions must not keep a row alive
        // for a placement that is over.
        //
        // `endAtAfter` is set to the placement's own `endAt`, which is what
        // the CHECK requires of a suspension that did not extend the clock and
        // is honest about one that did — the extension was already applied when
        // the run was resumed, or never happened at all.
        const placement = await tx.showcasePlacement.findUniqueOrThrow({
          where: { id: candidate.id },
          select: { endAt: true },
        });

        await tx.showcasePlacementSuspension.updateMany({
          where: { placementId: candidate.id, endedAt: null, extendsClock: false },
          data: { endedAt: now, endAtAfter: placement.endAt },
        });

        await tx.showcasePlacementSuspension.updateMany({
          where: { placementId: candidate.id, endedAt: null, extendsClock: true },
          data: { endedAt: now, endAtAfter: placement.endAt },
        });

        const shelves = await tx.showcasePlacementShelf.updateMany({
          where: { placementId: candidate.id, active: true },
          data: { active: false },
        });

        // The notice is owed by this transition, so its intent commits with
        // it — or not at all.
        await this.outbox.enqueueExpired(tx, candidate.id);

        return { expired: true, shelves: shelves.count };
      });

      if (outcome.expired) {
        expired += 1;
        shelvesClosed += outcome.shelves;
      } else {
        skipped += 1;
      }
    }

    if (expired > 0) {
      this.logger.log(`vitrin placements expired=${expired} shelvesClosed=${shelvesClosed}`);
    }

    const entitlementsExpired = await this.entitlements.expireStale(now, limit);

    // After the transitions: a run this tick just expired is no longer ACTIVE
    // and is not scanned for a reminder it would contradict.
    const remindersEnqueued = await this.outbox.enqueueEndingReminders(now, { limit });
    const notices = await this.outbox.deliverPending({ limit });

    return { expired, skipped, shelvesClosed, entitlementsExpired, remindersEnqueued, notices };
  }
}
