import { Inject, Injectable, Logger } from '@nestjs/common';
import { CampaignStatus, type CampaignEligibilityFact, type CampaignEvaluationOutcome, type Prisma } from '@prisma/client';
import { isWriteConflictError } from '../../../common/serializable-transaction';
import { grantPromoCreditLot } from '../../credits/promo-credit-ledger';
import { OPERATIONS_SETTINGS_ID } from '../../operations-settings/operations-settings.service';
import type { CampaignDefinition } from '../rules/types';
import { validateCampaignDefinition } from '../rules/validator';
import { CampaignFactReader } from './campaign-fact-reader';
import {
  CampaignEngineRepository,
  SAVEPOINT,
  isUniqueViolation,
  istanbulDay,
  type CandidateRow,
  type TriggerEventRow,
} from './campaign-engine.repository';
import { evaluateConditions, type EvaluationFacts } from './condition-evaluator';
import { FactSourceRegistry } from './fact-source-registry';
import {
  PROMOTION_GATED_TRIGGERS,
  PROMOTION_SNAPSHOT_VERSION,
  decidePromotionEligibility,
} from './promotion-eligibility';
import { PromotionEligibilityReader } from './promotion-eligibility.reader';
import { buildFactSetKey, buildTriggerEventKey, type CampaignTriggerInput } from './trigger-event-key';

/**
 * The campaign engine's boundary (CMP-002 S2A, granted in S2B2; contract
 * CMP-001 §12.4).
 *
 * Both entry points run inside the *caller's* transaction. Since S2B2 rev. 2
 * that caller is `CampaignEvaluationWorker` (stage B), which evaluates a
 * durable PENDING event in a transaction of its own, after the business
 * write that raised it has committed; the business flows themselves only
 * raise events (stage A, `CampaignEngineHooks`). This service is not
 * exported from `CampaignEngineModule` and no route calls it.
 *
 * Step zero of both is the kill switch, read inside the same transaction:
 * `OperationsSettings.campaignEngineEnabled` false, or no row at all, means
 * the answer is CAMPAIGN_ENGINE_DISABLED and nothing was read or written
 * beyond that one SELECT (design note D1). A default-off engine must cost the
 * flows it will one day hook nothing but that read.
 *
 * With the switch on, `evaluate` is the pipeline of §12.4: the event row
 * (global identity, idempotent), the settled short-circuit, the candidate set
 * with its window and conditions, the deterministic order, and one savepoint
 * per candidate inside which the four counters are consumed conditionally,
 * the redemption is written, and the S2B1 grant primitive appends the
 * CAMPAIGN_GRANT ledger row, creates the lot and links the redemption to its
 * ledger row — or everything is rolled back to the savepoint, logged, and the
 * next candidate tried. Exactly one candidate settles an event.
 *
 * Business outcomes are log rows and return values, never exceptions. An
 * unexpected error is contained at this boundary: everything the engine
 * wrote is rolled back to the outer savepoint and the caller gets
 * ENGINE_ERROR with its transaction still usable — the worker records the
 * code and parks the event for a retry. Serialization conflicts are the one
 * thing rethrown here, because the caller's `runSerializable` is the right
 * place to replay them.
 */

export type EngineInput = CampaignTriggerInput & {
  /** PROVIDER_APPROVED only: the raising write was a genuine transition into APPROVED. */
  approvalTransition?: boolean;
  /** PROVIDER_ELIGIBILITY_REACHED via onProviderFact: the fact whose write raised this evaluation. */
  raisedByFact?: CampaignEligibilityFact;
};

export type EngineDisabledResult = { outcome: 'CAMPAIGN_ENGINE_DISABLED' };

export type EngineErrorResult = { outcome: 'ENGINE_ERROR'; error: string };

export type EvaluationEntry = {
  campaignId: string | null;
  outcome: CampaignEvaluationOutcome;
  reasonCode: string | null;
};

export type GrantView = {
  campaignId: string;
  campaignVersionId: string;
  redemptionId: string;
  lotId: string;
  /** The CAMPAIGN_GRANT ledger row, also stored as `CampaignRedemption.grantTransactionId`. */
  grantTransactionId: string;
  grantedCredits: number;
  expiresAt: Date;
};

export type EngineEvaluatedResult = {
  outcome: 'EVALUATED';
  triggerEventId: string;
  triggerEventKey: string;
  granted: GrantView | null;
  /**
   * CMP-006 PR-C: the promotion eligibility gate answered REVIEW and wrote the
   * event's hold snapshot. The caller (the worker) parks the event
   * HELD_FOR_REVIEW; nothing was granted or consumed.
   */
  heldForReview: boolean;
  evaluations: EvaluationEntry[];
};

export type EngineResult = EngineDisabledResult | EngineEvaluatedResult | EngineErrorResult;

export type FactResult =
  | EngineDisabledResult
  | EngineErrorResult
  /** No ACTIVE eligibility campaign names this fact. */
  | { outcome: 'NO_FACT_SET' }
  /** Every set naming the fact still misses at least one other fact. */
  | { outcome: 'ELIGIBILITY_INCOMPLETE'; factSetKeys: string[] }
  | { outcome: 'EVALUATED'; evaluations: EngineEvaluatedResult[]; incompleteFactSetKeys: string[] };

type Candidate = CandidateRow & { definition: CampaignDefinition };

@Injectable()
export class CampaignEngineService {
  private readonly logger = new Logger(CampaignEngineService.name);

  constructor(
    @Inject(CampaignEngineRepository) private readonly repository: CampaignEngineRepository,
    @Inject(CampaignFactReader) private readonly facts: CampaignFactReader,
    @Inject(FactSourceRegistry) private readonly registry: FactSourceRegistry,
    @Inject(PromotionEligibilityReader) private readonly eligibility: PromotionEligibilityReader,
  ) {}

  async evaluate(tx: Prisma.TransactionClient, input: EngineInput): Promise<EngineResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    return this.contained(tx, SAVEPOINT.evaluation, () => this.evaluateEnabled(tx, input));
  }

  async onProviderFact(
    tx: Prisma.TransactionClient,
    providerId: string,
    fact: CampaignEligibilityFact,
  ): Promise<FactResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    return this.contained(tx, SAVEPOINT.fact, async () => {
      const sets = await this.repository.factSetsNaming(tx, fact);
      if (sets.length === 0) {
        return { outcome: 'NO_FACT_SET' } as const;
      }
      const evaluations: EngineEvaluatedResult[] = [];
      const incomplete: string[] = [];
      for (const set of sets) {
        // Never trust the caller's "it is true now": every fact of the set is
        // re-read from its canonical column, inside this transaction (§8.3).
        const values = await this.registry.readAll(tx, providerId, set.facts);
        if (!set.facts.every((name) => values[name])) {
          incomplete.push(set.factSetKey);
          continue;
        }
        const result = await this.evaluateEnabled(tx, {
          trigger: 'PROVIDER_ELIGIBILITY_REACHED',
          providerId,
          facts: set.facts,
          raisedByFact: fact,
        });
        evaluations.push(result);
      }
      if (evaluations.length === 0) {
        return { outcome: 'ELIGIBILITY_INCOMPLETE', factSetKeys: incomplete } as const;
      }
      return { outcome: 'EVALUATED', evaluations, incompleteFactSetKeys: incomplete } as const;
    });
  }

  // ───────────────────────────── pipeline ──────────────────────────────

  private async evaluateEnabled(tx: Prisma.TransactionClient, input: EngineInput): Promise<EngineEvaluatedResult> {
    const now = new Date();
    const triggerEventKey = buildTriggerEventKey(input);
    const factSetKey = input.trigger === 'PROVIDER_ELIGIBILITY_REACHED' ? buildFactSetKey(input.facts) : null;
    const purchaseId = input.trigger === 'PACKAGE_PAYMENT_SUCCEEDED' ? input.purchaseId : null;
    const fact = input.raisedByFact ?? null;

    // 1. The event: global identity, created once, counted every time.
    const event = await this.repository.ensureTriggerEvent(tx, {
      triggerEventKey,
      trigger: input.trigger,
      providerId: input.providerId,
      purchaseId,
      factSetKey,
    });
    const evaluations: EvaluationEntry[] = [];
    const log = async (
      campaign: { campaignId: string | null; campaignVersionId: string | null },
      outcome: CampaignEvaluationOutcome,
      extra: { reasonCode?: string | null; winnerCampaignId?: string | null } = {},
    ) => {
      await this.repository.appendLog(tx, {
        triggerEventId: event.id,
        providerId: input.providerId,
        campaignId: campaign.campaignId,
        campaignVersionId: campaign.campaignVersionId,
        outcome,
        reasonCode: extra.reasonCode ?? null,
        winnerCampaignId: extra.winnerCampaignId ?? null,
        fact,
      });
      evaluations.push({ campaignId: campaign.campaignId, outcome, reasonCode: extra.reasonCode ?? null });
    };
    const of = (candidate: CandidateRow) => ({ campaignId: candidate.id, campaignVersionId: candidate.activeVersion.id });
    const none = { campaignId: null, campaignVersionId: null };
    const result = (granted: GrantView | null, heldForReview = false): EngineEvaluatedResult => ({
      outcome: 'EVALUATED',
      triggerEventId: event.id,
      triggerEventKey,
      granted,
      heldForReview,
      evaluations,
    });

    const candidates = await this.repository.loadCandidates(tx, input.trigger, factSetKey);

    // 2. Already settled: the winner is told so, every other active
    //    candidate learns who won. Nothing is consumed.
    if (event.settledByCampaignId !== null) {
      const winner = candidates.find((candidate) => candidate.id === event.settledByCampaignId);
      await log(
        { campaignId: event.settledByCampaignId, campaignVersionId: winner?.activeVersion.id ?? null },
        'ALREADY_REDEEMED',
      );
      for (const candidate of candidates) {
        if (candidate.id !== event.settledByCampaignId && candidate.status === CampaignStatus.ACTIVE) {
          await log(of(candidate), 'EVENT_ALREADY_SETTLED', { winnerCampaignId: event.settledByCampaignId });
        }
      }
      return result(null);
    }

    // 3. Candidates. PAUSED is informational only; DRAFT/ENDED were never loaded.
    if (candidates.length === 0) {
      await log(none, 'NO_CANDIDATE');
      return result(null);
    }
    const active: Candidate[] = [];
    for (const candidate of candidates) {
      if (candidate.status === CampaignStatus.PAUSED) {
        await log(of(candidate), 'CAMPAIGN_PAUSED');
        continue;
      }
      active.push({ ...candidate, definition: parseDefinition(candidate) });
    }

    // 4. Window and conditions, from canonical facts read once per event.
    const facts = active.length > 0 ? await this.readFacts(tx, input, now) : null;
    const eligible: Candidate[] = [];
    for (const candidate of active) {
      const version = candidate.activeVersion;
      if ((version.windowStartAt && version.windowStartAt > now) || (version.windowEndAt && version.windowEndAt <= now)) {
        await log(of(candidate), 'WINDOW_CLOSED');
        continue;
      }
      const verdict = evaluateConditions(candidate.definition, facts!);
      if (!verdict.passed) {
        await log(of(candidate), 'CONDITIONS_FAILED', { reasonCode: verdict.failedCondition });
        continue;
      }
      eligible.push(candidate);
    }

    // 4b. PROVIDER_PROMOTION_ELIGIBLE (CMP-006 PR-C), for the introductory
    //     triggers and only when a candidate is left to grant: a person's
    //     decision on this event if there is one, the gate otherwise. REVIEW
    //     and INELIGIBLE log every surviving candidate and stop here — before
    //     any counter, limit or budget is touched.
    if (eligible.length > 0 && PROMOTION_GATED_TRIGGERS.has(input.trigger)) {
      const gate = await this.promotionGate(tx, event.id, input.providerId);
      if (gate.kind !== 'proceed') {
        const outcome = gate.kind === 'hold' ? 'PROMOTION_REVIEW_HELD' : 'PROMOTION_INELIGIBLE';
        for (const candidate of eligible) {
          await log(of(candidate), outcome, { reasonCode: gate.reasonCode });
        }
        return result(null, gate.kind === 'hold');
      }
    }

    // 5. EXCLUSIVE_CREDIT_BONUS order: most credits, then lowest priority
    //    number, then campaignId — fixed and free of any expression.
    eligible.sort(
      (a, b) =>
        b.activeVersion.benefitCredits - a.activeVersion.benefitCredits ||
        a.activeVersion.priority - b.activeVersion.priority ||
        a.id.localeCompare(b.id),
    );

    // 6. One savepoint per candidate; the first to clear its limits settles the event.
    const day = istanbulDay(now);
    for (let index = 0; index < eligible.length; index += 1) {
      const candidate = eligible[index]!;
      if (await this.repository.hasRedemption(tx, candidate.id, triggerEventKey)) {
        await log(of(candidate), 'ALREADY_REDEEMED');
        continue;
      }
      const attempt = await this.attemptGrant(tx, candidate, event, input.providerId, facts!.provider.userId, day, now);
      if (attempt.kind === 'refused') {
        await log(of(candidate), attempt.outcome);
        continue;
      }
      await log(of(candidate), 'GRANTED');
      for (const loser of eligible.slice(index + 1)) {
        await log(of(loser), 'STACK_CONFLICT', { winnerCampaignId: candidate.id });
      }
      return result({
        campaignId: candidate.id,
        campaignVersionId: candidate.activeVersion.id,
        redemptionId: attempt.redemptionId,
        lotId: attempt.lotId,
        grantTransactionId: attempt.grantTransactionId,
        grantedCredits: candidate.activeVersion.benefitCredits,
        expiresAt: attempt.expiresAt,
      });
    }
    return result(null);
  }

  /**
   * Counters, redemption, ledger row, lot, link and settlement for one
   * candidate, all under `cmp_candidate` and in that order (CMP-001 §10.3,
   * §12.4). A refused limit or a same-campaign P2002 rolls back to the
   * savepoint, so a candidate that did not win left nothing behind — no
   * counter, no redemption, no ledger row, no lot.
   */
  private async attemptGrant(
    tx: Prisma.TransactionClient,
    candidate: Candidate,
    event: TriggerEventRow,
    providerId: string,
    userId: string | null,
    day: Date,
    now: Date,
  ): Promise<
    | { kind: 'granted'; redemptionId: string; lotId: string; grantTransactionId: string; expiresAt: Date }
    | { kind: 'refused'; outcome: CampaignEvaluationOutcome }
  > {
    await this.repository.savepoint(tx, SAVEPOINT.candidate);
    try {
      const refusal = await this.repository.consumeLimits(tx, candidate, providerId, day);
      if (refusal) {
        await this.repository.rollbackTo(tx, SAVEPOINT.candidate);
        return { kind: 'refused', outcome: refusal };
      }
      const { redemptionId } = await this.repository.createRedemption(tx, { candidate, event, providerId, userId, now });
      // CAMPAIGN_GRANT ledger row → PromoCreditLot → redemption.grantTransactionId,
      // through the S2B1 primitive and nothing else. The lot expires
      // `benefitExpiresInDays` after this grant.
      const version = candidate.activeVersion;
      const expiresAt = new Date(now.getTime() + version.benefitExpiresInDays * 86_400_000);
      const grant = await grantPromoCreditLot(tx, {
        providerId,
        redemptionId,
        credits: version.benefitCredits,
        expiresAt,
        now,
      });
      await this.repository.settleEvent(tx, event.id, candidate.id, redemptionId);
      // CMP-006 PR-C: an introductory grant counts against the business
      // registration it was granted under — here, inside the candidate
      // savepoint, so a grant that is rolled back leaves no count behind.
      if (PROMOTION_GATED_TRIGGERS.has(event.trigger)) {
        await this.repository.countRegistrationGrant(tx, providerId, redemptionId);
      }
      await this.repository.release(tx, SAVEPOINT.candidate);
      return { kind: 'granted', redemptionId, lotId: grant.lotId, grantTransactionId: grant.transactionId, expiresAt };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The (campaignId, triggerEventKey) backstop: the primary read missed
        // a row this snapshot can see only now. Same answer as the read.
        await this.repository.rollbackTo(tx, SAVEPOINT.candidate);
        return { kind: 'refused', outcome: 'ALREADY_REDEEMED' };
      }
      throw error;
    }
  }

  /**
   * A person's decision wins and is never recomputed (design §2.4). Without
   * one: a hold snapshot that already exists keeps the event held (no second
   * snapshot), otherwise the gate decides and a REVIEW writes the snapshot.
   */
  private async promotionGate(
    tx: Prisma.TransactionClient,
    triggerEventId: string,
    providerId: string,
  ): Promise<{ kind: 'proceed' } | { kind: 'hold' | 'ineligible'; reasonCode: string }> {
    const review = await tx.promotionEligibilityReview.findUnique({
      where: { triggerEventId },
      select: { decision: true },
    });
    if (review) {
      return review.decision === 'ELIGIBLE' ? { kind: 'proceed' } : { kind: 'ineligible', reasonCode: 'HUMAN_DECISION' };
    }
    const existingHold = await tx.promotionEligibilityHold.findUnique({
      where: { triggerEventId },
      select: { signals: true },
    });
    if (existingHold) {
      return { kind: 'hold', reasonCode: firstSignalCode(existingHold.signals) ?? 'HELD' };
    }

    const decision = decidePromotionEligibility(await this.eligibility.read(tx, providerId));
    if (decision.outcome === 'ELIGIBLE') {
      return { kind: 'proceed' };
    }
    const reasonCode = decision.signals[0]!.code;
    if (decision.outcome === 'INELIGIBLE') {
      return { kind: 'ineligible', reasonCode };
    }
    await tx.promotionEligibilityHold.create({
      data: {
        triggerEventId,
        providerId,
        snapshotVersion: PROMOTION_SNAPSHOT_VERSION,
        signals: { outcome: decision.outcome, signals: decision.signals } as Prisma.InputJsonValue,
      },
    });
    return { kind: 'hold', reasonCode };
  }

  private async readFacts(tx: Prisma.TransactionClient, input: EngineInput, now: Date): Promise<EvaluationFacts> {
    const provider = await this.facts.provider(tx, input.providerId);
    if (!provider) {
      throw new Error(`Provider ${input.providerId} does not exist`);
    }
    const purchase =
      input.trigger === 'PACKAGE_PAYMENT_SUCCEEDED'
        ? await this.facts.purchase(tx, input.providerId, input.purchaseId)
        : undefined;
    if (input.trigger === 'PACKAGE_PAYMENT_SUCCEEDED' && !purchase) {
      throw new Error(`Purchase ${input.purchaseId} is not a PAID purchase of provider ${input.providerId}`);
    }
    return {
      now,
      provider,
      ...(purchase ? { purchase } : {}),
      approvalTransition: input.trigger === 'PROVIDER_APPROVED' ? input.approvalTransition === true : undefined,
    };
  }

  // ─────────────────────────── containment ────────────────────────────

  /**
   * Runs `work` under a savepoint. A business result passes through; a
   * serialization conflict is rethrown for the caller's retry loop; anything
   * else rolls the engine's writes back to the savepoint and becomes
   * ENGINE_ERROR — the caller's own writes, before and after, stand.
   */
  private async contained<T>(
    tx: Prisma.TransactionClient,
    savepoint: typeof SAVEPOINT.evaluation | typeof SAVEPOINT.fact,
    work: () => Promise<T>,
  ): Promise<T | EngineErrorResult> {
    await this.repository.savepoint(tx, savepoint);
    try {
      const value = await work();
      await this.repository.release(tx, savepoint);
      return value;
    } catch (error) {
      if (isWriteConflictError(error)) {
        throw error;
      }
      await this.repository.rollbackTo(tx, savepoint);
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`Campaign engine failed and was rolled back to ${savepoint}: ${message}`);
      return { outcome: 'ENGINE_ERROR', error: message };
    }
  }

  /** Fail-closed, and read on the caller's connection so it sees what the caller sees. */
  private async isEnabled(tx: Prisma.TransactionClient): Promise<boolean> {
    const row = await tx.operationsSettings.findUnique({
      where: { id: OPERATIONS_SETTINGS_ID },
      select: { campaignEngineEnabled: true },
    });
    return row?.campaignEngineEnabled === true;
  }
}

/** The stored definition, through the same parser that admitted it. Anything else is a fault. */
function parseDefinition(candidate: CandidateRow): CampaignDefinition {
  const parsed = validateCampaignDefinition(candidate.activeVersion.definition);
  if (!parsed.ok) {
    throw new Error(
      `CampaignVersion ${candidate.activeVersion.id} holds a definition the validator refuses: ${parsed.errors
        .map((entry) => `${entry.path} ${entry.code}`)
        .join(', ')}`,
    );
  }
  return parsed.definition;
}

function firstSignalCode(snapshot: Prisma.JsonValue): string | null {
  const signals = (snapshot as { signals?: Array<{ code?: unknown }> } | null)?.signals;
  const code = Array.isArray(signals) ? signals[0]?.code : undefined;
  return typeof code === 'string' ? code : null;
}
