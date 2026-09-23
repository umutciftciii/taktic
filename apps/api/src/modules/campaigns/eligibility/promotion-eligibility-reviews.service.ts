import { ConflictException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CampaignTriggerEventStatus, type Prisma, PromotionEligibilityDecision } from '@prisma/client';
import { runSerializable } from '../../../common/serializable-transaction';
import { PrismaService } from '../../../prisma/prisma.service';
import { isUniqueViolation } from '../engine/campaign-engine.repository';

export const ELIGIBILITY_HOLD_NOT_FOUND = 'ELIGIBILITY_HOLD_NOT_FOUND';
export const ELIGIBILITY_DECISION_ALREADY_RECORDED = 'ELIGIBILITY_DECISION_ALREADY_RECORDED';

const holdSelect = {
  id: true,
  triggerEventId: true,
  providerId: true,
  signals: true,
  snapshotVersion: true,
  heldAt: true,
  triggerEvent: {
    select: { id: true, triggerEventKey: true, trigger: true, status: true, factSetKey: true, lastSeenAt: true },
  },
  provider: { select: { id: true, businessName: true, status: true } },
  review: {
    select: {
      decision: true,
      reason: true,
      decidedAt: true,
      decidedBy: { select: { id: true, name: true, email: true } },
    },
  },
} satisfies Prisma.PromotionEligibilityHoldSelect;

type HoldRow = Prisma.PromotionEligibilityHoldGetPayload<{ select: typeof holdSelect }>;

/**
 * The promotion eligibility queue (CMP-006 PR-C): events the gate held for a
 * person, the snapshot it froze, and the one decision each may receive.
 *
 * The decision is a record, not an evaluation: it writes the review row and
 * moves the event — ELIGIBLE back to PENDING once, for the worker to evaluate
 * with the gate answered; INELIGIBLE to EVALUATED with a log row — and grants
 * nothing itself. It does not read the engine switch: deciding while the
 * engine is off is allowed, and nothing is granted until it is on.
 */
@Injectable()
export class PromotionEligibilityReviewsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The queue, or — with `providerId` — one provider's holds, which is the
   * eligibility context the operator's provider page shows (PR-C.1).
   */
  async list(filter: 'open' | 'decided' | 'all', providerId: string | null = null) {
    const rows = await this.prisma.promotionEligibilityHold.findMany({
      where: {
        ...(filter === 'open' ? { review: { is: null } } : filter === 'decided' ? { review: { isNot: null } } : {}),
        ...(providerId ? { providerId } : {}),
      },
      orderBy: [{ heldAt: filter === 'open' ? 'asc' : 'desc' }, { id: 'asc' }],
      take: 100,
      select: holdSelect,
    });
    return { items: rows.map(holdView) };
  }

  async get(triggerEventId: string) {
    const row = await this.prisma.promotionEligibilityHold.findUnique({ where: { triggerEventId }, select: holdSelect });
    if (!row) {
      throw holdNotFound();
    }
    const candidates = await this.prisma.campaignEvaluationLog.findMany({
      where: { triggerEventId, outcome: 'PROMOTION_REVIEW_HELD', campaignId: { not: null } },
      distinct: ['campaignId'],
      select: { campaign: { select: { id: true, key: true, name: true } } },
    });
    return {
      ...holdView(row),
      candidateCampaigns: candidates.flatMap((entry) => (entry.campaign ? [entry.campaign] : [])),
    };
  }

  async decide(
    triggerEventId: string,
    input: { decision: PromotionEligibilityDecision; reason: string },
    actorId: string,
  ) {
    const reason = input.reason.trim();
    try {
      await runSerializable(
        this.prisma,
        async (tx) => {
          const hold = await tx.promotionEligibilityHold.findUnique({
            where: { triggerEventId },
            select: { id: true, providerId: true, review: { select: { id: true } } },
          });
          if (!hold) {
            throw holdNotFound();
          }
          if (hold.review) {
            throw alreadyDecided();
          }
          const now = new Date();
          // The one move out of HELD_FOR_REVIEW, conditional on still being
          // there: a second decision, a concurrent one, or an event that is
          // somehow no longer held gets the same 409.
          const moved = await tx.campaignTriggerEvent.updateMany({
            where: { id: triggerEventId, status: CampaignTriggerEventStatus.HELD_FOR_REVIEW },
            data:
              input.decision === PromotionEligibilityDecision.ELIGIBLE
                ? { status: CampaignTriggerEventStatus.PENDING, nextAttemptAt: now, leaseUntil: null, lastErrorCode: null }
                : { status: CampaignTriggerEventStatus.EVALUATED, leaseUntil: null },
          });
          if (moved.count !== 1) {
            throw alreadyDecided();
          }
          await tx.promotionEligibilityReview.create({
            data: {
              triggerEventId,
              holdId: hold.id,
              providerId: hold.providerId,
              decision: input.decision,
              reason,
              decidedById: actorId,
              decidedAt: now,
            },
          });
          if (input.decision === PromotionEligibilityDecision.INELIGIBLE) {
            await tx.campaignEvaluationLog.create({
              data: {
                triggerEventId,
                providerId: hold.providerId,
                outcome: 'PROMOTION_INELIGIBLE',
                reasonCode: 'HUMAN_DECISION',
              },
            });
          }
        },
        { label: 'promotionEligibility.decide' },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw alreadyDecided();
      }
      throw error;
    }
    return this.get(triggerEventId);
  }
}

function holdView(row: HoldRow) {
  return {
    eventId: row.triggerEventId,
    triggerEventKey: row.triggerEvent.triggerEventKey,
    trigger: row.triggerEvent.trigger,
    eventStatus: row.triggerEvent.status,
    provider: row.provider,
    heldAt: row.heldAt,
    snapshotVersion: row.snapshotVersion,
    snapshot: row.signals,
    review: row.review,
  };
}

function holdNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: ELIGIBILITY_HOLD_NOT_FOUND,
    message: 'Bu olay için bekleyen bir uygunluk incelemesi yok.',
  });
}

function alreadyDecided() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: ELIGIBILITY_DECISION_ALREADY_RECORDED,
    message: 'Bu olay için uygunluk kararı zaten verilmiş.',
  });
}
