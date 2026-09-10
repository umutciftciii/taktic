import { Inject, Injectable } from '@nestjs/common';
import { ShowcasePlacementStatus, ShowcasePlacementSuspendReason } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { ShowcasePlacementReadService } from './showcase-placement-read.service';
import { ShowcasePlacementService } from './showcase-placement.service';
import {
  showcasePlacementNotCancellable,
  showcasePlacementNotFound,
  showcasePlacementNotResumable,
  showcasePlacementNotSuspendable,
} from './showcase.errors';

/**
 * The three things an operator may do to a paid run.
 *
 * There is no fourth. In particular there is no "create", no "extend" and no
 * "refund": a run is born from a settled payment, its length is what was
 * bought, and money is moved by people rather than by endpoints. What an
 * operator has is the power to take a card down and the power to put it back —
 * which is what makes moderation continue to mean something after somebody has
 * paid.
 */
@Injectable()
export class AdminShowcasePlacementsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcasePlacementService)
    private readonly placements: ShowcasePlacementService,
    @Inject(ShowcasePlacementReadService)
    private readonly read: ShowcasePlacementReadService,
  ) {}

  async suspend(placementId: string, user: AuthUser, note: string | null) {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const placement = await tx.showcasePlacement.findUnique({
          where: { id: placementId },
          select: { id: true, status: true },
        });

        if (!placement) {
          throw showcasePlacementNotFound();
        }

        const suspended = await this.placements.suspend(tx, placementId, {
          // Not taken from the body. An operator's action is ADMIN_ACTION by
          // definition, and a reason the caller could choose would let one be
          // recorded that does not stop the clock — an operator quietly billing
          // a provider for days the platform took away.
          reason: ShowcasePlacementSuspendReason.ADMIN_ACTION,
          actorUserId: user.id,
          note,
        });

        if (!suspended) {
          throw showcasePlacementNotSuspendable();
        }
      },
      { label: 'showcase.adminSuspendPlacement' },
    );

    return this.read.getForAdmin(placementId);
  }

  async resume(placementId: string) {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const placement = await tx.showcasePlacement.findUnique({
          where: { id: placementId },
          select: { id: true, status: true, suspendReason: true },
        });

        if (!placement) {
          throw showcasePlacementNotFound();
        }

        // Only an operator's own hold. See `showcasePlacementNotResumable`.
        const resumed = await this.placements.resume(tx, placementId, {
          expectedReason: ShowcasePlacementSuspendReason.ADMIN_ACTION,
        });

        if (!resumed) {
          throw showcasePlacementNotResumable();
        }
      },
      { label: 'showcase.adminResumePlacement' },
    );

    return this.read.getForAdmin(placementId);
  }

  /**
   * Ends a run early, and flags the purchase for a person.
   *
   * `manualReviewReason` is the existing mechanism a payment reversal already
   * uses, reused rather than duplicated: an operator looking at the finance
   * screens sees one list of "purchases somebody has to decide about", not two.
   *
   * Any open suspension is closed with the run, so the partial unique index on
   * open suspensions does not keep a row alive for a placement that is over.
   */
  async cancel(placementId: string, user: AuthUser, note: string | null) {
    const now = new Date();

    await runSerializable(
      this.prisma,
      async (tx) => {
        const placement = await tx.showcasePlacement.findUnique({
          where: { id: placementId },
          select: { id: true, status: true, endAt: true, purchaseId: true },
        });

        if (!placement) {
          throw showcasePlacementNotFound();
        }

        const cancelled = await tx.showcasePlacement.updateMany({
          where: {
            id: placementId,
            status: {
              in: [
                ShowcasePlacementStatus.PENDING_ACTIVATION,
                ShowcasePlacementStatus.ACTIVE,
                ShowcasePlacementStatus.SUSPENDED,
              ],
            },
          },
          data: {
            status: ShowcasePlacementStatus.CANCELLED,
            cancelledAt: now,
            suspendedAt: null,
            suspendReason: null,
          },
        });

        if (cancelled.count !== 1) {
          throw showcasePlacementNotCancellable();
        }

        await tx.showcasePlacementSuspension.updateMany({
          where: { placementId, endedAt: null },
          // `endAtAfter` equals `endAtBefore` here whatever the flag says: a
          // cancellation is not a resume and gives nothing back, and the CHECK
          // that refuses an unexplained extension is satisfied either way.
          data: { endedAt: now, endAtAfter: placement.endAt },
        });

        await tx.showcasePlacementShelf.updateMany({
          where: { placementId },
          data: { active: false },
        });

        // The flag, not a refund. Identical in mechanism to how a chargeback
        // is handled: a person decides what the money should do.
        await tx.packagePurchase.updateMany({
          where: { id: placement.purchaseId, manualReviewAt: null },
          data: {
            manualReviewReason: SHOWCASE_PLACEMENT_CANCELLED_REASON,
            manualReviewAt: now,
            adminNote: note,
          },
        });

        void user;
      },
      { label: 'showcase.adminCancelPlacement' },
    );

    return this.read.getForAdmin(placementId);
  }
}

/**
 * Why a vitrin purchase is waiting for a person.
 *
 * A short machine code beside `PAYMENT_REVERSAL_REPORTED`, never a sentence and
 * never anything about an amount: the finance screens map it onto their own
 * wording, and this string goes into a database column an operator filters on.
 */
export const SHOWCASE_PLACEMENT_CANCELLED_REASON = 'SHOWCASE_PLACEMENT_CANCELLED';
