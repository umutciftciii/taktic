import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CampaignAuditAction,
  CampaignRedemptionStatus,
  CampaignRevokeReason,
  CampaignStatus,
  type Prisma,
} from '@prisma/client';
import { revokePromoCreditLot } from '../../credits/promo-credit-ledger';
import { CampaignEngineRepository, CampaignEngineWriteConflict, isUniqueViolation } from './campaign-engine.repository';

/**
 * The one way a granted promotion is taken back (CMP-003 S3).
 *
 * Two callers, one path. A verified payment reversal
 * (`PaymentsWebhookService.flagForManualReview`) revokes every GRANTED
 * redemption of the refunded purchase; a SUPER_ADMIN revokes one redemption
 * with a reason (`CampaignsService.revokeRedemption`). Both run inside the
 * caller's Serializable transaction and both do exactly this, in order:
 *
 *   1. `revokePromoCreditLot` (S2B1): one CAMPAIGN_REVOKE row for whatever
 *      the lot still holds — none when nothing is left — the lot REVOKED with
 *      zero remainder, the redemption GRANTED → REVOKED with the reason, the
 *      moment, the actor and `spentAtRevoke`. What was spent is a record, not
 *      a debt (CMP-001 §2.6): no negative balance, no paid credit touched.
 *   2. The redemption's provenance: the operator's note, or the webhook event
 *      whose reversal did it.
 *   3. The campaign's UTC daily revoke counter, moved by one.
 *   4. The threshold: past the *running* version's `maxRevokesPerDay`, an
 *      ACTIVE campaign goes PAUSED with one AUTO_PAUSED audit row — written
 *      only when the conditional status update took, so a campaign already
 *      paused, ended, or paused by a concurrent revoke gets no second row.
 *
 * Nothing here reads the engine switch. The switch guards new entitlement;
 * reversing a lot that already exists is accounting and stays possible with
 * the engine off. Nothing here is a grant, an evaluation or a candidate load.
 *
 * Idempotency is the redemption's own status: only a GRANTED row is revoked,
 * every write is a conditional update, and a conditional that matches
 * nothing carries P2034 so the caller's `runSerializable` replays and then
 * finds nothing left to do. A second delivery of the same reversal, a second
 * reversal event for the same order, or a second operator click therefore
 * produces no second ledger row, counter step, audit row or pause.
 */

export type RevokeSource =
  | { kind: 'PAYMENT_REVERSED'; webhookEventId: string }
  | { kind: 'ADMIN_REVOKED'; actorId: string; note: string };

export type RevokeOutcome = {
  redemptionId: string;
  campaignId: string;
  campaignVersionId: string;
  providerId: string;
  lotId: string;
  /** What left the wallet: the lot's remainder at revoke time. */
  revokedCredits: number;
  spentAtRevoke: number;
  /** The CAMPAIGN_REVOKE ledger row; null when the lot had nothing left. */
  transactionId: string | null;
  /** The campaign's revoke count for today (UTC) after this one. */
  revokeCountToday: number;
  /** True when *this* revoke moved the campaign ACTIVE → PAUSED. */
  autoPaused: boolean;
};

export const AUTO_PAUSE_REASON = 'REVOKE_THRESHOLD_EXCEEDED';

const redemptionSelect = {
  id: true,
  campaignId: true,
  campaignVersionId: true,
  providerId: true,
  status: true,
  grantedCredits: true,
  campaignVersion: { select: { versionNumber: true } },
  promoLot: { select: { id: true, status: true, remainingCredits: true } },
  campaign: {
    select: {
      id: true,
      status: true,
      activeVersionId: true,
      activeVersion: { select: { id: true, versionNumber: true, maxRevokesPerDay: true } },
    },
  },
} satisfies Prisma.CampaignRedemptionSelect;

type RedemptionRow = Prisma.CampaignRedemptionGetPayload<{ select: typeof redemptionSelect }>;

@Injectable()
export class CampaignRevokeService {
  private readonly logger = new Logger(CampaignRevokeService.name);

  constructor(@Inject(CampaignEngineRepository) private readonly repository: CampaignEngineRepository) {}

  /**
   * Every GRANTED redemption the refunded purchase produced, revoked with
   * PAYMENT_REVERSED. Returns what was revoked; empty when the purchase earned
   * no promotion or its promotion is already gone — which is what makes the
   * refund of an ordinary package a no-op here.
   */
  async revokeForRefundedPurchase(
    tx: Prisma.TransactionClient,
    input: { purchaseId: string; webhookEventId: string; now: Date },
  ): Promise<RevokeOutcome[]> {
    const rows = await tx.campaignRedemption.findMany({
      where: { purchaseId: input.purchaseId, status: CampaignRedemptionStatus.GRANTED },
      orderBy: { id: 'asc' },
      select: redemptionSelect,
    });
    const outcomes: RevokeOutcome[] = [];
    for (const row of rows) {
      const outcome = await this.revoke(tx, row, { kind: 'PAYMENT_REVERSED', webhookEventId: input.webhookEventId }, input.now);
      if (outcome) {
        // The record of the system's own act (CMP-004 S4): no person, the
        // SYSTEM marker the database requires, and the same figures the
        // admin route records — never the webhook's payload or the buyer.
        await tx.campaignAuditLog.create({
          data: {
            campaignId: row.campaignId,
            action: CampaignAuditAction.REDEMPTION_REVOKED,
            campaignVersionId: row.campaignVersionId,
            actorId: null,
            summary: {
              actorKind: 'SYSTEM',
              source: 'PAYMENT_REVERSED',
              redemptionId: row.id,
              versionNumber: row.campaignVersion.versionNumber,
              revokedCredits: outcome.revokedCredits,
              spentAtRevoke: outcome.spentAtRevoke,
              revokeCountToday: outcome.revokeCountToday,
              autoPaused: outcome.autoPaused,
            },
          },
        });
        outcomes.push(outcome);
      }
    }
    return outcomes;
  }

  /**
   * One redemption, revoked by an operator. Returns null when the row is not
   * GRANTED (already revoked or expired) — the caller decides the HTTP
   * answer; nothing was written.
   */
  async revokeRedemption(
    tx: Prisma.TransactionClient,
    input: { redemptionId: string; actorId: string; note: string; now: Date },
  ): Promise<RevokeOutcome | null> {
    const row = await tx.campaignRedemption.findUnique({ where: { id: input.redemptionId }, select: redemptionSelect });
    if (!row || row.status !== CampaignRedemptionStatus.GRANTED) {
      return null;
    }
    return this.revoke(tx, row, { kind: 'ADMIN_REVOKED', actorId: input.actorId, note: input.note }, input.now);
  }

  // ─────────────────────────────── core ───────────────────────────────

  private async revoke(tx: Prisma.TransactionClient, row: RedemptionRow, source: RevokeSource, now: Date): Promise<RevokeOutcome | null> {
    if (!row.promoLot) {
      // A GRANTED redemption always has its lot (the grant is one savepoint);
      // a row without one is not something to revoke money from.
      this.logger.warn(`Campaign redemption ${row.id} is GRANTED but has no promo lot; nothing to revoke`);
      return null;
    }

    const reason = source.kind === 'PAYMENT_REVERSED' ? CampaignRevokeReason.PAYMENT_REVERSED : CampaignRevokeReason.ADMIN_REVOKED;
    const revokedById = source.kind === 'ADMIN_REVOKED' ? source.actorId : null;
    const result = await revokePromoCreditLot(tx, { lotId: row.promoLot.id, reason, revokedById, now });
    if (!result.revoked) {
      // The lot is already EXPIRED or REVOKED under a GRANTED redemption —
      // a state no writer produces. Leave it for a person; move no money.
      this.logger.warn(`Campaign redemption ${row.id} is GRANTED but its lot is ${row.promoLot.status}; nothing to revoke`);
      return null;
    }

    const provenance = await tx.campaignRedemption.updateMany({
      where: { id: row.id, status: CampaignRedemptionStatus.REVOKED, revokeNote: null, revokedByWebhookEventId: null },
      data:
        source.kind === 'PAYMENT_REVERSED'
          ? { revokedByWebhookEventId: source.webhookEventId }
          : { revokeNote: source.note },
    });
    if (provenance.count !== 1) {
      throw new CampaignEngineWriteConflict(`CampaignRedemption ${row.id} (provenance)`);
    }

    const revokeCountToday = await this.countRevoke(tx, row.campaignId, now);
    const autoPaused = await this.pauseIfOverThreshold(tx, row, source, revokeCountToday, now);

    return {
      redemptionId: row.id,
      campaignId: row.campaignId,
      campaignVersionId: row.campaignVersionId,
      providerId: row.providerId,
      lotId: row.promoLot.id,
      revokedCredits: result.credits,
      spentAtRevoke: row.grantedCredits - result.credits,
      transactionId: result.transactionId,
      revokeCountToday,
      autoPaused,
    };
  }

  /** The campaign's counter for the UTC day of `now`, moved by one; returns the new count. */
  private async countRevoke(tx: Prisma.TransactionClient, campaignId: string, now: Date): Promise<number> {
    const day = utcDay(now);
    try {
      await tx.campaignRevokeDailyCounter.upsert({
        where: { campaignId_day: { campaignId, day } },
        create: { campaignId, day },
        update: {},
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CampaignEngineWriteConflict('CampaignRevokeDailyCounter');
      }
      throw error;
    }
    const moved = await tx.campaignRevokeDailyCounter.update({
      where: { campaignId_day: { campaignId, day } },
      data: { revokeCount: { increment: 1 } },
      select: { revokeCount: true },
    });
    return moved.revokeCount;
  }

  /**
   * The threshold is the running version's; a campaign with no running
   * version, no threshold, or a count within it is left alone. The status
   * move is conditional on ACTIVE, and the audit row follows only a move
   * that took — one pause per crossing, whatever the concurrency.
   */
  private async pauseIfOverThreshold(
    tx: Prisma.TransactionClient,
    row: RedemptionRow,
    source: RevokeSource,
    revokeCountToday: number,
    now: Date,
  ): Promise<boolean> {
    const running = row.campaign.activeVersion;
    if (!running || running.maxRevokesPerDay === null || revokeCountToday <= running.maxRevokesPerDay) {
      return false;
    }
    const paused = await tx.campaign.updateMany({
      where: { id: row.campaignId, status: CampaignStatus.ACTIVE },
      data: { status: CampaignStatus.PAUSED },
    });
    if (paused.count !== 1) {
      return false;
    }
    // The operator whose revoke crossed the line, or nobody: a reversal is
    // the system's own act and is recorded as such (CMP-004 S4, Migration G
    // — the SYSTEM marker in the summary is what the CHECK requires of a
    // NULL actor).
    const actorId = source.kind === 'ADMIN_REVOKED' ? source.actorId : null;
    await tx.campaignAuditLog.create({
      data: {
        campaignId: row.campaignId,
        action: CampaignAuditAction.AUTO_PAUSED,
        campaignVersionId: running.id,
        actorId,
        summary: {
          reason: AUTO_PAUSE_REASON,
          actorKind: source.kind === 'ADMIN_REVOKED' ? 'ADMIN' : 'SYSTEM',
          source: source.kind,
          day: utcDay(now).toISOString().slice(0, 10),
          revokeCount: revokeCountToday,
          maxRevokesPerDay: running.maxRevokesPerDay,
          versionNumber: running.versionNumber,
          redemptionId: row.id,
        },
      },
    });
    this.logger.warn(
      `Campaign ${row.campaignId} paused itself: ${revokeCountToday} revokes today exceed the running version's threshold of ${running.maxRevokesPerDay}`,
    );
    return true;
  }
}

/** The UTC calendar date of `now`, as the UTC-midnight Date a `@db.Date` column stores. */
export function utcDay(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}
