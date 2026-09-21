import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { type CampaignEligibilityFact, CampaignTriggerEventStatus, type Prisma } from '@prisma/client';
import { readCampaignEvaluationCron } from '../../../common/scheduler-cron';
import { isConcurrentModificationError, runSerializable } from '../../../common/serializable-transaction';
import { PrismaService } from '../../../prisma/prisma.service';
import { OPERATIONS_SETTINGS_ID } from '../../operations-settings/operations-settings.service';
import { CampaignEngineRepository, type TriggerEventRow } from './campaign-engine.repository';
import { CampaignEngineService, type EngineInput } from './campaign-engine.service';
import { FactSourceRegistry } from './fact-source-registry';

/**
 * Stage B of the campaign engine's two-stage contract (CMP-002 S2B2 rev. 2):
 * the only caller of `CampaignEngineService.evaluate` in the application.
 *
 * Every business transaction that raises a campaign event leaves behind one
 * durable PENDING `CampaignTriggerEvent` row and nothing else (stage A,
 * `CampaignEngineHooks`). This worker turns those rows into evaluations,
 * one event per Serializable transaction of its own, after the business
 * write has long since committed — so nothing it does, and nothing that goes
 * wrong in it, can touch an approval, a proof or a payment.
 *
 * Claim: `claimDueEvent` takes one due row with `FOR UPDATE SKIP LOCKED`
 * and moves it to PROCESSING with a five-minute lease in the same statement.
 * Two workers (two API instances, a tick and a restart, four concurrent
 * `runOnce` calls) cannot hold the same event; a worker that dies mid-flight
 * leaves a lease that expires and the event is claimable again. The lease
 * value is the claim token: the outcome is written `WHERE leaseUntil = token`
 * (`finishClaim`), so a worker whose lease expired and was taken over cannot
 * commit its evaluation on top of the successor's.
 *
 * Outcome → state:
 *   grant                       SETTLED (written by the engine's own settlement)
 *   evaluated, no grant         EVALUATED — a later raise of the key reopens it
 *   ENGINE_ERROR                RETRY_WAIT, `nextAttemptAt` = now + backoff,
 *                               EvaluationLog{ENGINE_ERROR, reasonCode} (a closed
 *                               code, never the message), lastErrorCode
 *   serialization exhausted     RETRY_WAIT, lastErrorCode CONCURRENT_MODIFICATION
 *   anything else               RETRY_WAIT, lastErrorCode WORKER_ERROR
 *   engine switched off         PENDING again, lease released, nothing logged
 *
 * Backoff doubles from one minute and is capped at six hours; there is no
 * terminal "forgotten" state — an event that keeps failing stays RETRY_WAIT,
 * visible with its code and count, and is retried on every due tick. The
 * engine's exclusive-stack decision is recomputed on every attempt, so a
 * fault while evaluating one candidate never lets another candidate win by
 * default: nothing of a failed attempt is committed.
 *
 * Off means off: the tick reads `campaignEngineEnabled` first and returns
 * without claiming anything while it is false, and `evaluate` reads it again
 * inside the transaction. The schedule is deployment configuration
 * (`CAMPAIGN_EVALUATION_RETRY_CRON`); there is no operations switch for this
 * worker because the engine switch is that switch.
 */

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_BATCH = 50;
const evaluationCron = readCampaignEvaluationCron();

export type WorkerEventOutcome =
  | 'SETTLED'
  | 'EVALUATED'
  | 'ELIGIBILITY_INCOMPLETE'
  | 'ENGINE_ERROR'
  | 'ENGINE_DISABLED'
  | 'CONCURRENT_MODIFICATION'
  | 'WORKER_ERROR'
  | 'LEASE_LOST';

export type WorkerRunResult = {
  skipped: 'ENGINE_DISABLED' | 'ALREADY_RUNNING' | null;
  claimed: number;
  outcomes: Array<{ triggerEventKey: string; outcome: WorkerEventOutcome }>;
};

@Injectable()
export class CampaignEvaluationWorker implements OnModuleInit {
  private readonly logger = new Logger(CampaignEvaluationWorker.name);
  private isRunning = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CampaignEngineRepository) private readonly repository: CampaignEngineRepository,
    @Inject(CampaignEngineService) private readonly engine: CampaignEngineService,
    @Inject(FactSourceRegistry) private readonly registry: FactSourceRegistry,
  ) {}

  onModuleInit() {
    this.logger.log(
      `Campaign evaluation worker registered with cron "${evaluationCron}"; claims nothing while the campaign engine switch is off`,
    );
  }

  @Cron(evaluationCron, { name: 'campaign-evaluation' })
  async tick() {
    const result = await this.runOnce();
    if (result.claimed > 0) {
      const counts = result.outcomes.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.outcome] = (acc[entry.outcome] ?? 0) + 1;
        return acc;
      }, {});
      this.logger.log(
        `Campaign evaluation tick claimed=${result.claimed} ${Object.entries(counts)
          .map(([key, value]) => `${key.toLowerCase()}=${value}`)
          .join(' ')}`,
      );
    }
  }

  /**
   * One pass: claim and evaluate due events until none is due or `limit`
   * is reached. `now` is a test seam for "later" (backoff, lease expiry).
   * Concurrent passes in one process are serialised by `isRunning`; across
   * processes the database claim does the same job.
   */
  async runOnce(options: { now?: Date; limit?: number } = {}): Promise<WorkerRunResult> {
    const limit = options.limit ?? DEFAULT_BATCH;
    if (!(await this.isEnabled())) {
      return { skipped: 'ENGINE_DISABLED', claimed: 0, outcomes: [] };
    }
    if (this.isRunning) {
      return { skipped: 'ALREADY_RUNNING', claimed: 0, outcomes: [] };
    }
    this.isRunning = true;
    const outcomes: WorkerRunResult['outcomes'] = [];
    try {
      for (let index = 0; index < limit; index += 1) {
        const now = options.now ?? new Date();
        const event = await this.repository.claimDueEvent(this.prisma, now);
        if (!event) {
          break;
        }
        const outcome = await this.evaluateClaimed(event, now);
        outcomes.push({ triggerEventKey: event.triggerEventKey, outcome });
      }
    } finally {
      this.isRunning = false;
    }
    return { skipped: null, claimed: outcomes.length, outcomes };
  }

  /** One claimed event, one Serializable transaction, one guarded outcome write. */
  private async evaluateClaimed(event: TriggerEventRow, now: Date): Promise<WorkerEventOutcome> {
    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          // The lease is checked first, inside the snapshot: a successor's
          // claim after our lease expired is an update of this very row, so
          // Serializable makes our later writes conflict with it and nothing
          // of this attempt can commit on top of theirs.
          const held = await tx.campaignTriggerEvent.count({
            where: { id: event.id, status: CampaignTriggerEventStatus.PROCESSING, leaseUntil: event.leaseUntil },
          });
          if (held !== 1) {
            throw new LeaseLostError(event.triggerEventKey);
          }

          const input = await this.inputFor(tx, event);
          if (input === null) {
            // The eligibility set is no longer complete (a number changed and
            // its proof was reset). Not a fault: logged, and the next raise
            // — the last fact landing again — reopens the event.
            await this.repository.appendLog(tx, {
              triggerEventId: event.id,
              providerId: event.providerId,
              campaignId: null,
              campaignVersionId: null,
              outcome: 'ELIGIBILITY_INCOMPLETE',
            });
            return this.finish(tx, event, { status: 'EVALUATED' }, 'ELIGIBILITY_INCOMPLETE');
          }

          const result = await this.engine.evaluate(tx, input);
          if (result.outcome === 'CAMPAIGN_ENGINE_DISABLED') {
            // Switched off between the tick's check and this transaction:
            // release the claim untouched, log nothing.
            return this.finish(tx, event, { status: 'PENDING' }, 'ENGINE_DISABLED');
          }
          if (result.outcome === 'ENGINE_ERROR') {
            // The engine rolled its own writes back to its savepoint; this
            // transaction is intact. Record the closed code and the retry.
            await this.repository.appendLog(tx, {
              triggerEventId: event.id,
              providerId: event.providerId,
              campaignId: null,
              campaignVersionId: null,
              outcome: 'ENGINE_ERROR',
              reasonCode: 'ENGINE_ERROR',
            });
            return this.finish(tx, event, this.retry(event, 'ENGINE_ERROR', now), 'ENGINE_ERROR');
          }
          // EVALUATED: a grant's settlement already wrote SETTLED, inside the
          // engine, in this transaction, after the lease check above.
          return result.granted ? 'SETTLED' : this.finish(tx, event, { status: 'EVALUATED' }, 'EVALUATED');
        },
        { label: 'campaigns.evaluateEvent' },
      );
    } catch (error) {
      // Nothing of the attempt committed. Park the event for a later tick,
      // guarded by our lease so a successor's outcome is never overwritten.
      if (error instanceof LeaseLostError) {
        this.logger.warn(error.message);
        return 'LEASE_LOST';
      }
      const code = isConcurrentModificationError(error) ? 'CONCURRENT_MODIFICATION' : 'WORKER_ERROR';
      this.logger.error(
        `Campaign evaluation of ${event.triggerEventKey} failed (${code}); event parked for retry: ${
          error instanceof Error ? error.name : String(error)
        }`,
      );
      const parked = await this.repository.finishClaim(this.prisma, event, this.retry(event, code, now));
      return parked ? code : 'LEASE_LOST';
    }
  }

  private async finish(
    tx: Prisma.TransactionClient,
    event: TriggerEventRow,
    outcome: Parameters<CampaignEngineRepository['finishClaim']>[2],
    reported: WorkerEventOutcome,
  ): Promise<WorkerEventOutcome> {
    const held = await this.repository.finishClaim(tx, event, outcome);
    if (!held) {
      throw new LeaseLostError(event.triggerEventKey);
    }
    return reported;
  }

  private retry(event: TriggerEventRow, lastErrorCode: string, now: Date) {
    const delay = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, event.attemptCount - 1), RETRY_MAX_MS);
    return { status: 'RETRY_WAIT' as const, nextAttemptAt: new Date(now.getTime() + delay), lastErrorCode, now };
  }

  /**
   * The engine input an event row stands for. An eligibility event re-reads
   * its facts from the canonical columns first; null means the set no longer
   * holds. A PROVIDER_APPROVED event exists only because a genuine transition
   * raised it, so it carries `approvalTransition: true`.
   */
  private async inputFor(tx: Prisma.TransactionClient, event: TriggerEventRow): Promise<EngineInput | null> {
    switch (event.trigger) {
      case 'PROVIDER_APPROVED':
        return { trigger: 'PROVIDER_APPROVED', providerId: event.providerId, approvalTransition: true };
      case 'PACKAGE_PAYMENT_SUCCEEDED':
        return { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: event.providerId, purchaseId: event.purchaseId! };
      case 'PROVIDER_ELIGIBILITY_REACHED': {
        const facts = (event.factSetKey ?? '').split('+').filter(Boolean) as CampaignEligibilityFact[];
        const values = await this.registry.readAll(tx, event.providerId, facts);
        if (facts.length === 0 || !facts.every((fact) => values[fact])) {
          return null;
        }
        return { trigger: 'PROVIDER_ELIGIBILITY_REACHED', providerId: event.providerId, facts };
      }
    }
  }

  private async isEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { campaignEngineEnabled: true },
      });
      return row?.campaignEngineEnabled === true;
    } catch (error) {
      this.logger.error(
        `Campaign engine setting could not be read; the worker claims nothing (${error instanceof Error ? error.name : 'UnknownError'})`,
      );
      return false;
    }
  }
}

/** The lease was taken over while this attempt ran; the attempt's transaction must not commit. */
class LeaseLostError extends Error {
  constructor(key: string) {
    super(`Campaign evaluation of ${key}: lease lost to another worker; attempt discarded`);
    this.name = 'LeaseLostError';
  }
}
