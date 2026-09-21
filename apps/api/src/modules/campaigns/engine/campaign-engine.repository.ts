import { Injectable } from '@nestjs/common';
import {
  type CampaignEligibilityFact,
  type CampaignEvaluationOutcome,
  CampaignStatus,
  type CampaignTrigger,
  CampaignTriggerEventStatus,
  Prisma,
} from '@prisma/client';
import { PRISMA_WRITE_CONFLICT_ERROR_CODE } from '../../../common/serializable-transaction';

/**
 * Every row the campaign engine writes, and the few it reads to decide
 * (CMP-001 §12.4). One method per step, all on the caller's transaction
 * client. The credit ledger and the promo lot are *not* written here: the
 * engine service calls the S2B1 grant primitive (`grantPromoCreditLot`) right
 * after `createRedemption`, so CAMPAIGN_GRANT, the lot and the redemption's
 * `grantTransactionId` come from the one writer that owns that accounting.
 *
 * Savepoints are plain SQL on the transaction's own connection (a Prisma
 * interactive transaction holds exactly one). They are what let a unique
 * violation — the backstop behind the primary read-based idempotency — or a
 * refused limit be undone for one candidate without aborting the trigger
 * transaction the engine is a guest in.
 */

/** Savepoint names are constants; nothing user-supplied reaches a raw statement. */
export const SAVEPOINT = {
  evaluation: 'cmp_eval',
  fact: 'cmp_fact',
  event: 'cmp_event',
  candidate: 'cmp_candidate',
} as const;

type SavepointName = (typeof SAVEPOINT)[keyof typeof SAVEPOINT];

/**
 * Raised when a unique violation reveals a concurrent transaction whose row
 * this snapshot cannot see. Under Serializable the right answer is to replay
 * the whole trigger transaction, which is what `runSerializable` does for
 * P2034 — so this carries that code.
 */
export class CampaignEngineWriteConflict extends Error {
  readonly code = PRISMA_WRITE_CONFLICT_ERROR_CODE;

  constructor(what: string) {
    super(`Campaign engine: concurrent write on ${what}; the transaction must be replayed`);
    this.name = 'CampaignEngineWriteConflict';
  }
}

export const activeVersionSelect = {
  id: true,
  trigger: true,
  eligibilityFacts: true,
  factSetKey: true,
  definition: true,
  benefitCredits: true,
  benefitExpiresInDays: true,
  maxRedemptionsPerProvider: true,
  maxRedemptionsGlobal: true,
  maxRedemptionsPerDay: true,
  budgetCredits: true,
  windowStartAt: true,
  windowEndAt: true,
  priority: true,
} satisfies Prisma.CampaignVersionSelect;

export const candidateSelect = {
  id: true,
  status: true,
  activeVersion: { select: activeVersionSelect },
} satisfies Prisma.CampaignSelect;

export type CandidateRow = Prisma.CampaignGetPayload<{ select: typeof candidateSelect }> & {
  activeVersion: Prisma.CampaignVersionGetPayload<{ select: typeof activeVersionSelect }>;
};

export type TriggerEventRow = Prisma.CampaignTriggerEventGetPayload<{ select: typeof eventSelect }>;

const eventSelect = {
  id: true,
  triggerEventKey: true,
  trigger: true,
  providerId: true,
  purchaseId: true,
  factSetKey: true,
  evaluationCount: true,
  settledByCampaignId: true,
  settledRedemptionId: true,
  status: true,
  attemptCount: true,
  leaseUntil: true,
  claimedAt: true,
  nextAttemptAt: true,
  lastErrorCode: true,
} satisfies Prisma.CampaignTriggerEventSelect;

/** How long a worker's claim on an event lasts before another worker may take it over. */
export const EVENT_LEASE_MS = 5 * 60_000;

export type LimitRefusal = 'PER_PROVIDER_LIMIT' | 'DAILY_LIMIT' | 'GLOBAL_LIMIT' | 'BUDGET_EXHAUSTED';

@Injectable()
export class CampaignEngineRepository {
  // ───────────────────────────── savepoints ─────────────────────────────

  async savepoint(tx: Prisma.TransactionClient, name: SavepointName) {
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  }

  async rollbackTo(tx: Prisma.TransactionClient, name: SavepointName) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
  }

  async release(tx: Prisma.TransactionClient, name: SavepointName) {
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
  }

  // ─────────────────────────────── event ────────────────────────────────

  /**
   * The event row for this key, created if this is its first sighting, with
   * `evaluationCount` moved by one. Insert under a savepoint: a P2002 means
   * another transaction created it — visible to us if it committed before our
   * snapshot (re-read), otherwise the trigger transaction has to be replayed.
   */
  async ensureTriggerEvent(
    tx: Prisma.TransactionClient,
    input: {
      triggerEventKey: string;
      trigger: CampaignTrigger;
      providerId: string;
      purchaseId: string | null;
      factSetKey: string | null;
    },
  ): Promise<TriggerEventRow> {
    const existing = await tx.campaignTriggerEvent.findUnique({
      where: { triggerEventKey: input.triggerEventKey },
      select: eventSelect,
    });
    let event = existing;
    if (!event) {
      await this.savepoint(tx, SAVEPOINT.event);
      try {
        event = await tx.campaignTriggerEvent.create({ data: input, select: eventSelect });
        await this.release(tx, SAVEPOINT.event);
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        await this.rollbackTo(tx, SAVEPOINT.event);
        event = await tx.campaignTriggerEvent.findUnique({
          where: { triggerEventKey: input.triggerEventKey },
          select: eventSelect,
        });
        if (!event) {
          throw new CampaignEngineWriteConflict(`CampaignTriggerEvent ${input.triggerEventKey}`);
        }
      }
    }
    return tx.campaignTriggerEvent.update({
      where: { id: event.id },
      data: { lastSeenAt: new Date(), evaluationCount: { increment: 1 } },
      select: eventSelect,
    });
  }

  /** Settlement and the SETTLED status in one statement (the CHECK ties them together). */
  async settleEvent(tx: Prisma.TransactionClient, eventId: string, campaignId: string, redemptionId: string) {
    await tx.campaignTriggerEvent.update({
      where: { id: eventId },
      data: {
        settledByCampaignId: campaignId,
        settledRedemptionId: redemptionId,
        settledAt: new Date(),
        status: CampaignTriggerEventStatus.SETTLED,
        leaseUntil: null,
        lastErrorCode: null,
      },
    });
  }

  // ─────────────────────── durable pending events (S2B2 rev. 2) ───────────────────────

  /**
   * Stage A of a hook: the event row for this key exists, PENDING, when the
   * business transaction commits — and nothing else is written. A key seen
   * before is bumped (`lastSeenAt`); one that had been evaluated without a
   * grant goes back to PENDING so the new raise is evaluated again; a SETTLED
   * event stays settled (a grant exists, the key is lifetime-unique); a
   * PROCESSING or RETRY_WAIT event is left to its worker. The insert runs
   * under a savepoint: a P2002 means a concurrent transaction created it —
   * re-read if visible, otherwise replay the business transaction (P2034).
   */
  async ensurePendingEvent(
    tx: Prisma.TransactionClient,
    input: {
      triggerEventKey: string;
      trigger: CampaignTrigger;
      providerId: string;
      purchaseId: string | null;
      factSetKey: string | null;
    },
    now: Date,
  ): Promise<{ id: string; status: CampaignTriggerEventStatus; created: boolean }> {
    const existing = await tx.campaignTriggerEvent.findUnique({
      where: { triggerEventKey: input.triggerEventKey },
      select: { id: true, status: true },
    });
    if (existing) {
      const reopen = existing.status === CampaignTriggerEventStatus.EVALUATED;
      const updated = await tx.campaignTriggerEvent.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: now,
          ...(reopen ? { status: CampaignTriggerEventStatus.PENDING, nextAttemptAt: now, lastErrorCode: null } : {}),
        },
        select: { id: true, status: true },
      });
      return { ...updated, created: false };
    }
    await this.savepoint(tx, SAVEPOINT.event);
    try {
      const created = await tx.campaignTriggerEvent.create({
        data: { ...input, status: CampaignTriggerEventStatus.PENDING, nextAttemptAt: now, firstSeenAt: now, lastSeenAt: now },
        select: { id: true, status: true },
      });
      await this.release(tx, SAVEPOINT.event);
      return { ...created, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      await this.rollbackTo(tx, SAVEPOINT.event);
      const raced = await tx.campaignTriggerEvent.findUnique({
        where: { triggerEventKey: input.triggerEventKey },
        select: { id: true, status: true },
      });
      if (!raced) {
        throw new CampaignEngineWriteConflict(`CampaignTriggerEvent ${input.triggerEventKey}`);
      }
      return { ...raced, created: false };
    }
  }

  /**
   * Stage B's claim: one due event, taken with `FOR UPDATE SKIP LOCKED` so
   * two workers — two instances, two ticks, a tick and a restart — never
   * hold the same event, and moved to PROCESSING with a lease in the same
   * statement. Due means PENDING or RETRY_WAIT with `nextAttemptAt` reached,
   * or PROCESSING with a lease that expired (a worker that died mid-flight).
   * Returns the claimed row, whose `leaseUntil` is the claim token.
   */
  async claimDueEvent(db: Prisma.TransactionClient | { $queryRaw: Prisma.TransactionClient['$queryRaw'] }, now: Date): Promise<TriggerEventRow | null> {
    const leaseUntil = new Date(now.getTime() + EVENT_LEASE_MS);
    const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
      UPDATE "CampaignTriggerEvent"
      SET "status" = 'PROCESSING',
          "leaseUntil" = ${leaseUntil},
          "claimedAt" = ${now},
          "lastAttemptAt" = ${now},
          "attemptCount" = "attemptCount" + 1
      WHERE "id" = (
        SELECT "id" FROM "CampaignTriggerEvent"
        WHERE ("status" IN ('PENDING', 'RETRY_WAIT') AND "nextAttemptAt" <= ${now})
           OR ("status" = 'PROCESSING' AND "leaseUntil" < ${now})
        ORDER BY "nextAttemptAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING "id", "triggerEventKey", "trigger", "providerId", "purchaseId", "factSetKey", "evaluationCount",
                "settledByCampaignId", "settledRedemptionId", "status", "attemptCount", "leaseUntil", "claimedAt",
                "nextAttemptAt", "lastErrorCode"
    `;
    const row = rows[0];
    return row ? (row as unknown as TriggerEventRow) : null;
  }

  /**
   * The end of a claim, guarded by the claim token: only the worker that
   * holds this lease may write the outcome. Zero rows means the lease expired
   * and another worker took the event over — the caller must not commit its
   * evaluation over theirs.
   */
  async finishClaim(
    tx: Prisma.TransactionClient,
    event: { id: string; leaseUntil: Date | null },
    outcome:
      | { status: 'EVALUATED' | 'PENDING' }
      | { status: 'RETRY_WAIT'; nextAttemptAt: Date; lastErrorCode: string; now: Date },
  ): Promise<boolean> {
    const result = await tx.campaignTriggerEvent.updateMany({
      where: { id: event.id, status: CampaignTriggerEventStatus.PROCESSING, leaseUntil: event.leaseUntil },
      data:
        outcome.status === 'RETRY_WAIT'
          ? {
              status: CampaignTriggerEventStatus.RETRY_WAIT,
              leaseUntil: null,
              nextAttemptAt: outcome.nextAttemptAt,
              lastErrorCode: outcome.lastErrorCode,
              lastErrorAt: outcome.now,
            }
          : { status: outcome.status, leaseUntil: null, lastErrorCode: null },
    });
    return result.count === 1;
  }

  // ───────────────────────────── candidates ─────────────────────────────

  /**
   * ACTIVE and PAUSED campaigns whose active version answers this trigger
   * (and, on the eligibility transition, exactly this fact set). DRAFT and
   * ENDED are never candidates and never logged (CMP-001 §10.5).
   */
  async loadCandidates(
    tx: Prisma.TransactionClient,
    trigger: CampaignTrigger,
    factSetKey: string | null,
  ): Promise<CandidateRow[]> {
    const rows = await tx.campaign.findMany({
      where: {
        status: { in: [CampaignStatus.ACTIVE, CampaignStatus.PAUSED] },
        activeVersionId: { not: null },
        activeVersion: { trigger, factSetKey },
      },
      select: candidateSelect,
      orderBy: { id: 'asc' },
    });
    return rows.filter((row): row is CandidateRow => row.activeVersion !== null);
  }

  /** Distinct fact sets of ACTIVE eligibility campaigns that name `fact`. */
  async factSetsNaming(tx: Prisma.TransactionClient, fact: CampaignEligibilityFact) {
    const versions = await tx.campaignVersion.findMany({
      where: {
        trigger: 'PROVIDER_ELIGIBILITY_REACHED',
        eligibilityFacts: { has: fact },
        activeOf: { status: CampaignStatus.ACTIVE },
      },
      select: { factSetKey: true, eligibilityFacts: true },
      orderBy: { factSetKey: 'asc' },
    });
    const sets = new Map<string, CampaignEligibilityFact[]>();
    for (const version of versions) {
      if (version.factSetKey && !sets.has(version.factSetKey)) {
        sets.set(version.factSetKey, version.eligibilityFacts);
      }
    }
    return [...sets.entries()].map(([factSetKey, facts]) => ({ factSetKey, facts }));
  }

  async hasRedemption(tx: Prisma.TransactionClient, campaignId: string, triggerEventKey: string) {
    const row = await tx.campaignRedemption.findUnique({
      where: { campaignId_triggerEventKey: { campaignId, triggerEventKey } },
      select: { id: true },
    });
    return row !== null;
  }

  // ─────────────────────────────── limits ───────────────────────────────

  /**
   * CMP-001 §10.3, in order: per-provider, per-day, then the campaign's global
   * count and credit budget — each a conditional update whose WHERE is the
   * limit, so the last slot cannot be taken twice. Returns the first refusal,
   * or null when every counter moved. The caller holds the candidate
   * savepoint and rolls back on refusal.
   */
  async consumeLimits(
    tx: Prisma.TransactionClient,
    candidate: CandidateRow,
    providerId: string,
    day: Date,
  ): Promise<LimitRefusal | null> {
    const version = candidate.activeVersion;

    await this.ensureCounter(
      () => tx.campaignProviderCounter.upsert({
        where: { campaignId_providerId: { campaignId: candidate.id, providerId } },
        create: { campaignId: candidate.id, providerId },
        update: {},
        select: { id: true },
      }),
      'CampaignProviderCounter',
    );
    const perProvider = await tx.campaignProviderCounter.updateMany({
      where: { campaignId: candidate.id, providerId, redemptionCount: { lt: version.maxRedemptionsPerProvider } },
      data: { redemptionCount: { increment: 1 } },
    });
    if (perProvider.count !== 1) {
      return 'PER_PROVIDER_LIMIT';
    }

    await this.ensureCounter(
      () => tx.campaignDailyCounter.upsert({
        where: { campaignId_day: { campaignId: candidate.id, day } },
        create: { campaignId: candidate.id, day },
        update: {},
        select: { id: true },
      }),
      'CampaignDailyCounter',
    );
    const perDay = await tx.campaignDailyCounter.updateMany({
      where: {
        campaignId: candidate.id,
        day,
        ...(version.maxRedemptionsPerDay !== null ? { redemptionCount: { lt: version.maxRedemptionsPerDay } } : {}),
      },
      data: { redemptionCount: { increment: 1 } },
    });
    if (perDay.count !== 1) {
      return 'DAILY_LIMIT';
    }

    const campaign = await tx.campaign.updateMany({
      where: {
        id: candidate.id,
        ...(version.maxRedemptionsGlobal !== null ? { redemptionCount: { lt: version.maxRedemptionsGlobal } } : {}),
        ...(version.budgetCredits !== null
          ? { budgetConsumedCredits: { lte: version.budgetCredits - version.benefitCredits } }
          : {}),
      },
      data: { redemptionCount: { increment: 1 }, budgetConsumedCredits: { increment: version.benefitCredits } },
    });
    if (campaign.count !== 1) {
      // Which of the two refused, for the log. A separate read, after the fact.
      const row = await tx.campaign.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { redemptionCount: true },
      });
      return version.maxRedemptionsGlobal !== null && row.redemptionCount >= version.maxRedemptionsGlobal
        ? 'GLOBAL_LIMIT'
        : 'BUDGET_EXHAUSTED';
    }
    return null;
  }

  private async ensureCounter(upsert: () => Promise<unknown>, table: string) {
    try {
      await upsert();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CampaignEngineWriteConflict(table);
      }
      throw error;
    }
  }

  // ─────────────────────────────── grant ────────────────────────────────

  /**
   * The redemption row, and only that. The ledger row, the lot and the link
   * between them follow in the service through `grantPromoCreditLot`, whose
   * contract (S2B1) this slice does not change. A P2002 here is the
   * same-campaign-same-event backstop; the caller rolls back to the candidate
   * savepoint and records ALREADY_REDEEMED.
   */
  async createRedemption(
    tx: Prisma.TransactionClient,
    args: {
      candidate: CandidateRow;
      event: TriggerEventRow;
      providerId: string;
      userId: string | null;
      now: Date;
    },
  ): Promise<{ redemptionId: string }> {
    const version = args.candidate.activeVersion;
    const redemption = await tx.campaignRedemption.create({
      data: {
        campaignId: args.candidate.id,
        campaignVersionId: version.id,
        providerId: args.providerId,
        userId: args.userId,
        trigger: args.event.trigger,
        triggerEventId: args.event.id,
        triggerEventKey: args.event.triggerEventKey,
        purchaseId: args.event.purchaseId,
        rulesSnapshot: version.definition as Prisma.InputJsonValue,
        grantedCredits: version.benefitCredits,
        grantedAt: args.now,
      },
      select: { id: true },
    });
    return { redemptionId: redemption.id };
  }

  // ──────────────────────────────── log ─────────────────────────────────

  async appendLog(
    tx: Prisma.TransactionClient,
    entry: {
      triggerEventId: string;
      providerId: string;
      campaignId: string | null;
      campaignVersionId: string | null;
      outcome: CampaignEvaluationOutcome;
      reasonCode?: string | null;
      winnerCampaignId?: string | null;
      fact?: CampaignEligibilityFact | null;
    },
  ) {
    await tx.campaignEvaluationLog.create({
      data: {
        triggerEventId: entry.triggerEventId,
        providerId: entry.providerId,
        campaignId: entry.campaignId,
        campaignVersionId: entry.campaignVersionId,
        outcome: entry.outcome,
        reasonCode: entry.reasonCode ?? null,
        winnerCampaignId: entry.winnerCampaignId ?? null,
        fact: entry.fact ?? null,
      },
    });
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
    (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002')
  );
}

/** The Europe/Istanbul calendar date of `now`, as the UTC-midnight Date a `@db.Date` column stores. */
export function istanbulDay(now: Date): Date {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${formatted}T00:00:00.000Z`);
}
