import { Inject, Injectable, Logger } from '@nestjs/common';
import { OfferAllowanceStatus } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import {
  enqueueShowcaseAllowanceVoidedNotice,
  ShowcaseAllowanceVoidOutbox,
} from '../notifications/showcase-allowance-void-outbox.service';
import { countLeadsAwaitingFreeAnswer } from '../offer-allowances/offer-allowance-ledger';
import { logOfferAllowanceEvent } from '../offer-allowances/offer-allowance-events';
import {
  SHOWCASE_ALLOWANCE_VOID_NOTE_MIN_LENGTH,
  type ShowcaseAllowanceVoidDto,
} from './dto/showcase-placement-admin.dto';
import { ShowcasePlacementReadService } from './showcase-placement-read.service';
import {
  offerAllowanceAlreadyVoid,
  offerAllowanceChanged,
  offerAllowanceNotFound,
  offerAllowanceNothingToVoid,
  offerAllowanceVoidNoteRequired,
  offerAllowanceZeroPackage,
  showcasePlacementNotFound,
} from './showcase.errors';

/**
 * SHOWCASE-ALLOWANCE-004 — a super admin voids what is left of a vitrin run's
 * free offers.
 *
 * What it does, all in one Serializable transaction:
 *
 * 1. reads the run and its grant, and refuses — with its own code — a run with
 *    no grant, one sold with 0 free offers, a grant already VOID, or one with
 *    nothing left;
 * 2. counts the run's leads still waiting for a free answer and compares the
 *    three figures the confirmation dialog showed (granted, spent, waiting)
 *    with the truth, refusing 409 OFFER_ALLOWANCE_CHANGED on any difference;
 * 3. flips the grant to VOID with a conditional `updateMany` whose WHERE
 *    repeats ACTIVE and both quota figures, so a slot claimed in between can
 *    never be "voided" after it was spent;
 * 4. writes the provider's notice as an outbox intent in the same transaction.
 *
 * What it deliberately does not do: touch a usage row, the credit ledger, a
 * wallet, a purchase, a showcase entitlement, the placement or any lead. The
 * slots already spent stay spent and counted; the leads still open stay open
 * and are answered at the category's credit price from now on. No refund, no
 * credit, no cancellation follows from a void, and nothing else voids a grant.
 *
 * Idempotency is the database's: the conditional update matches only an
 * ACTIVE row, and the trigger refuses any write to a VOID one, so a replayed
 * or concurrent second void writes nothing and is answered 409
 * OFFER_ALLOWANCE_ALREADY_VOID (or, mid-race, CONCURRENT_MODIFICATION).
 */
@Injectable()
export class ShowcaseAllowanceVoidService {
  private readonly logger = new Logger('OfferAllowance');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcasePlacementReadService) private readonly read: ShowcasePlacementReadService,
    @Inject(ShowcaseAllowanceVoidOutbox) private readonly notices: ShowcaseAllowanceVoidOutbox,
  ) {}

  async voidAllowance(placementId: string, user: AuthUser, dto: ShowcaseAllowanceVoidDto) {
    // Required, and judged trimmed: the DTO only proves it is a string.
    const note = dto.note.trim();
    if (note.length < SHOWCASE_ALLOWANCE_VOID_NOTE_MIN_LENGTH) {
      throw offerAllowanceVoidNoteRequired(SHOWCASE_ALLOWANCE_VOID_NOTE_MIN_LENGTH);
    }

    const now = new Date();

    const voided = await runSerializable(
      this.prisma,
      async (tx) => {
        const placement = await tx.showcasePlacement.findUnique({
          where: { id: placementId },
          select: {
            id: true,
            providerId: true,
            freeOfferCountSnapshot: true,
            offerAllowanceGrant: {
              select: { id: true, providerId: true, status: true, quotaTotal: true, quotaUsed: true },
            },
          },
        });

        if (!placement) {
          throw showcasePlacementNotFound();
        }

        const grant = placement.offerAllowanceGrant;
        if (!grant) {
          throw placement.freeOfferCountSnapshot === 0 ? offerAllowanceZeroPackage() : offerAllowanceNotFound();
        }
        if (grant.status === OfferAllowanceStatus.VOID) {
          throw offerAllowanceAlreadyVoid();
        }
        if (grant.quotaUsed >= grant.quotaTotal) {
          throw offerAllowanceNothingToVoid();
        }

        const openLeads = await countLeadsAwaitingFreeAnswer(tx, {
          placementId: placement.id,
          providerId: grant.providerId,
        });
        if (
          dto.expectedQuotaTotal !== grant.quotaTotal ||
          dto.expectedQuotaUsed !== grant.quotaUsed ||
          dto.expectedOpenLeads !== openLeads
        ) {
          throw offerAllowanceChanged({ quotaTotal: grant.quotaTotal, quotaUsed: grant.quotaUsed, openLeads });
        }

        const updated = await tx.offerAllowanceGrant.updateMany({
          where: {
            id: grant.id,
            status: OfferAllowanceStatus.ACTIVE,
            quotaTotal: grant.quotaTotal,
            quotaUsed: grant.quotaUsed,
          },
          data: {
            status: OfferAllowanceStatus.VOID,
            voidedAt: now,
            voidReason: dto.reasonCode,
            voidNote: note,
            voidedById: user.id,
          },
        });
        if (updated.count !== 1) {
          // Under Serializable a concurrent change normally surfaces as a
          // write conflict and a replay, which then reads the new state; this
          // is the same fact reached without one.
          throw offerAllowanceChanged({ quotaTotal: grant.quotaTotal, quotaUsed: grant.quotaUsed, openLeads });
        }

        await enqueueShowcaseAllowanceVoidedNotice(tx, grant.id);

        return {
          grantId: grant.id,
          providerId: grant.providerId,
          voidedCount: grant.quotaTotal - grant.quotaUsed,
          quotaTotal: grant.quotaTotal,
          quotaUsed: grant.quotaUsed,
          openLeads,
        };
      },
      { label: 'showcase.adminVoidAllowance' },
    );

    // After the commit: a replayed or refused attempt never counts, and the
    // notice goes out only for a void that happened.
    logOfferAllowanceEvent(this.logger, 'offer_allowance_voided', {
      grantId: voided.grantId,
      placementId,
      voidedCount: voided.voidedCount,
      quotaTotal: voided.quotaTotal,
      quotaUsed: voided.quotaUsed,
      openLeads: voided.openLeads,
      reasonCode: dto.reasonCode,
    });
    this.notices.deliverSoon();

    return this.read.getForAdmin(placementId, user);
  }
}
