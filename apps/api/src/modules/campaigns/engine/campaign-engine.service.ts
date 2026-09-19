import { Inject, Injectable, Logger } from '@nestjs/common';
import { CampaignStatus, type CampaignEligibilityFact, type CampaignEvaluationOutcome, type Prisma } from '@prisma/client';
import { isWriteConflictError } from '../../../common/serializable-transaction';
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
import { buildFactSetKey, buildTriggerEventKey, type CampaignTriggerInput } from './trigger-event-key';

/**
 * The campaign engine's boundary (CMP-002 S2A; contract CMP-001 §12.4).
 *
 * Both entry points run inside the *caller's* transaction — the approval, the
 * webhook settlement, the proof write — and neither is called by any of them
 * in this slice: no hook exists yet, and `CampaignsModule` does not export
 * this service. The only caller today is the test suite.
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
 * per candidate inside which the four counters are consumed conditionally and
 * the redemption and lot are written — or rolled back to the savepoint,
 * logged, and the next candidate tried. Exactly one candidate settles an
 * event. **No ledger row is written** (design note D3): S2B adds
 * CAMPAIGN_GRANT beside the redemption when `CreditTransactionType` grows.
 *
 * Business outcomes are log rows and return values, never exceptions. An
 * unexpected error is contained: everything the engine wrote is rolled back
 * to the outer savepoint and the caller gets ENGINE_ERROR with its own
 * transaction intact — a campaign fault must not undo a payment, an approval
 * or a proof. Serialization conflicts are the one thing rethrown, because
 * the caller's `runSerializable` is the right place to replay them.
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
  grantedCredits: number;
  expiresAt: Date;
};

export type EngineEvaluatedResult = {
  outcome: 'EVALUATED';
  triggerEventId: string;
  triggerEventKey: string;
  granted: GrantView | null;
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
    const result = (granted: GrantView | null): EngineEvaluatedResult => ({
      outcome: 'EVALUATED',
      triggerEventId: event.id,
      triggerEventKey,
      granted,
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
        grantedCredits: candidate.activeVersion.benefitCredits,
        expiresAt: attempt.expiresAt,
      });
    }
    return result(null);
  }

  /**
   * Counters, redemption, lot and settlement for one candidate, all under
   * `cmp_candidate`. A refused limit or a same-campaign P2002 rolls back to
   * the savepoint, so a candidate that did not win left nothing behind.
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
    | { kind: 'granted'; redemptionId: string; lotId: string; expiresAt: Date }
    | { kind: 'refused'; outcome: CampaignEvaluationOutcome }
  > {
    await this.repository.savepoint(tx, SAVEPOINT.candidate);
    try {
      const refusal = await this.repository.consumeLimits(tx, candidate, providerId, day);
      if (refusal) {
        await this.repository.rollbackTo(tx, SAVEPOINT.candidate);
        return { kind: 'refused', outcome: refusal };
      }
      const grant = await this.repository.createRedemptionAndLot(tx, { candidate, event, providerId, userId, now });
      await this.repository.settleEvent(tx, event.id, candidate.id, grant.redemptionId);
      await this.repository.release(tx, SAVEPOINT.candidate);
      return { kind: 'granted', ...grant };
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
