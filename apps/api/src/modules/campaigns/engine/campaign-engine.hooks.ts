import { HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  type CampaignEligibilityFact,
  type CampaignTriggerEventStatus,
  type Prisma,
  SourceChannel,
  UserRole,
} from '@prisma/client';
import { isWriteConflictError } from '../../../common/serializable-transaction';
import { OPERATIONS_SETTINGS_ID } from '../../operations-settings/operations-settings.service';
import { CampaignEngineRepository } from './campaign-engine.repository';
import {
  type CampaignFactSource,
  type ChannelProducer,
  FactSourceRegistry,
  type FactWriter,
  type RegistrableChannel,
} from './fact-source-registry';
import { buildFactSetKey, buildTriggerEventKey, type CampaignTriggerInput } from './trigger-event-key';

/**
 * Stage A of the campaign engine's two-stage contract (CMP-002 S2B2 rev. 2):
 * the only way a business flow reaches the engine, and the only thing it
 * does is make the event durable.
 *
 * Three hooks, one per trigger class of CMP-001 §2.3, each called by the
 * canonical writer of the fact *inside the Serializable transaction that
 * persists it*, as that transaction's last step and only after the guarded
 * write reported `count === 1`:
 *
 *   providerApproved         ProvidersService.updateProviderStatus, on a
 *                            genuine transition into APPROVED
 *   accountFactProven        EmailVerificationService.confirm (EMAIL_VERIFIED)
 *                            and PhoneVerificationService.verifyAccountCode
 *                            (PHONE_VERIFIED), for a PROVIDER account
 *   packagePaymentSucceeded  PaymentsWebhookService.settle and
 *                            PackagePurchasesService.mockPayProviderPurchase,
 *                            after the purchase was written PAID
 *
 * What a hook writes is exactly one thing: the deterministic
 * `CampaignTriggerEvent` row for the key, PENDING (`ensurePendingEvent`). It
 * does not evaluate a rule, a budget, a stack order or a grant — that is
 * stage B, `CampaignEvaluationWorker`, which runs after this transaction has
 * committed, in its own transaction, and can be retried. The business write
 * and the pending event therefore commit together or not at all, and a
 * campaign evaluation can never roll back an approval, a proof or a payment:
 * it has not happened yet when they commit.
 *
 * While the engine switch is off a hook reads one settings row and returns:
 * no event, no log, no row of any kind (the S2A zero-effect contract).
 *
 * Durability rule (rev. 3): with the engine on, the business transaction may
 * commit **only** with its PENDING event(s) durably ensured in the same
 * transaction. Until `ensurePendingEvent` has returned for every key the
 * raise produces, *any* error — a bug in the fact-set lookup, a validation
 * slip, a database fault — propagates and rolls the caller's transaction
 * back with a retryable 503 (`CAMPAIGN_EVENT_NOT_DURABLE`); the provider
 * redelivers, the operator or the owner tries again, and the retry raises
 * the same key. There is no savepoint and no catch here that could let a
 * business write commit over a missing event: "the payment settled but the
 * campaign event is certainly lost" is the one outcome ruled out. A
 * serialization conflict is rethrown as always, for the caller's
 * `runSerializable` to replay. Nothing campaign-rule-shaped runs in this
 * stage — no definition is parsed, no candidate is loaded — so a fault in a
 * campaign's configuration cannot reach it; those faults belong to stage B,
 * where they park the event for a retry and touch nothing else.
 *
 * Writers register themselves here at boot (`registerFactWriter`), which is
 * what the activation gate reads: a version that depends on a source no
 * booted module raises cannot go ACTIVE (`FACT_SOURCE_UNAVAILABLE`).
 *
 * Channel (CMP-006 PR-D). Every event is written with the `sourceChannel` of
 * the business act that raised it, derived here from the canonical row and
 * never from anything a client sent:
 *
 *   PROVIDER_APPROVED             ProviderProfile.applicationSourceChannel —
 *                                 the approving request is the operator's;
 *                                 the business came in through its application
 *   PACKAGE_PAYMENT_SUCCEEDED     PackagePurchase.sourceChannel — the webhook
 *                                 that settles it has no channel of its own
 *   PROVIDER_ELIGIBILITY_REACHED  the channel of the proof that completed the
 *                                 set: the application's when the approval
 *                                 did, the caller's (server-derived) when an
 *                                 account proof did
 *
 * The channel is written on INSERT only (`ensurePendingEvent`), is not part
 * of `triggerEventKey`, and a database trigger refuses to change it — so a
 * re-raise that derives a different channel neither moves the event nor
 * mints a second one. Producers register at boot (`registerChannelSource`);
 * the activation gate refuses a WEB/MOBILE version whose sources have no
 * producer of that channel (`CHANNEL_SOURCE_UNAVAILABLE`).
 */

export const CAMPAIGN_EVENT_NOT_DURABLE = 'CAMPAIGN_EVENT_NOT_DURABLE';

export type AccountProofFact = Extract<CampaignEligibilityFact, 'EMAIL_VERIFIED' | 'PHONE_VERIFIED'>;

export type RaisedEvent = { triggerEventKey: string; id: string; status: CampaignTriggerEventStatus; created: boolean };

export type HookResult =
  | { outcome: 'CAMPAIGN_ENGINE_DISABLED' }
  /** The account is not a PROVIDER's, or has no profile: a customer's or an operator's proof is no campaign fact. */
  | { outcome: 'NOT_A_PROVIDER_FACT' }
  | { outcome: 'RAISED'; events: RaisedEvent[]; incompleteFactSetKeys: string[] };

@Injectable()
export class CampaignEngineHooks {
  private readonly logger = new Logger(CampaignEngineHooks.name);

  constructor(
    @Inject(CampaignEngineRepository) private readonly repository: CampaignEngineRepository,
    @Inject(FactSourceRegistry) private readonly registry: FactSourceRegistry,
  ) {}

  /** Called once by each writer module at boot; see FactSourceRegistry. */
  registerFactWriter(source: CampaignFactSource, writer: FactWriter): void {
    this.registry.register(source, writer);
  }

  /** Called at boot by each module that derives a channel for `source`'s events on the server. */
  registerChannelSource(source: CampaignFactSource, channel: RegistrableChannel, producer: ChannelProducer): void {
    this.registry.registerChannel(source, channel, producer);
  }

  /**
   * A genuine transition into APPROVED: the PROVIDER_APPROVED event itself,
   * plus — the fact having become true — every eligibility set that names it
   * and is now complete.
   */
  async providerApproved(tx: Prisma.TransactionClient, providerId: string): Promise<HookResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    return this.durable(async (now) => {
      const profile = await tx.providerProfile.findUnique({
        where: { id: providerId },
        select: { applicationSourceChannel: true },
      });
      const sourceChannel = profile?.applicationSourceChannel ?? SourceChannel.UNKNOWN;
      const events: RaisedEvent[] = [];
      events.push(await this.raise(tx, { trigger: 'PROVIDER_APPROVED', providerId }, sourceChannel, now));
      const eligibility = await this.raiseEligibility(tx, providerId, 'PROVIDER_APPROVED', sourceChannel, now);
      events.push(...eligibility.events);
      return { outcome: 'RAISED', events, incompleteFactSetKeys: eligibility.incompleteFactSetKeys } as const;
    });
  }

  /**
   * An account proof that just became true for `userId`. Resolved to the
   * provider profile the account owns; a CUSTOMER's or SUPER_ADMIN's proof,
   * or an account with no profile, produces no campaign fact at all.
   *
   * `sourceChannel` is the channel of the proof itself, as the *server*
   * knows it from the route that confirmed it — the web application's
   * confirmation routes pass WEB; anything that cannot vouch passes UNKNOWN.
   */
  async accountFactProven(
    tx: Prisma.TransactionClient,
    userId: string,
    fact: AccountProofFact,
    sourceChannel: SourceChannel,
  ): Promise<HookResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    const profile = await tx.providerProfile.findUnique({
      where: { userId },
      select: { id: true, user: { select: { role: true } } },
    });
    if (!profile || profile.user?.role !== UserRole.PROVIDER) {
      return { outcome: 'NOT_A_PROVIDER_FACT' };
    }
    return this.durable(async (now) => {
      const eligibility = await this.raiseEligibility(tx, profile.id, fact, sourceChannel, now);
      return { outcome: 'RAISED', ...eligibility } as const;
    });
  }

  /** A purchase this transaction has just written PAID through a verified settlement path. */
  async packagePaymentSucceeded(tx: Prisma.TransactionClient, providerId: string, purchaseId: string): Promise<HookResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    return this.durable(async (now) => {
      const purchase = await tx.packagePurchase.findUnique({
        where: { id: purchaseId },
        select: { sourceChannel: true },
      });
      const sourceChannel = purchase?.sourceChannel ?? SourceChannel.UNKNOWN;
      return {
        outcome: 'RAISED' as const,
        events: [await this.raise(tx, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId, purchaseId }, sourceChannel, now)],
        incompleteFactSetKeys: [],
      };
    });
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async raise(
    tx: Prisma.TransactionClient,
    input: CampaignTriggerInput,
    sourceChannel: SourceChannel,
    now: Date,
  ): Promise<RaisedEvent> {
    // The key is built from the input alone: the channel never enters it.
    const triggerEventKey = buildTriggerEventKey(input);
    const ensured = await this.repository.ensurePendingEvent(
      tx,
      {
        triggerEventKey,
        trigger: input.trigger,
        providerId: input.providerId,
        purchaseId: input.trigger === 'PACKAGE_PAYMENT_SUCCEEDED' ? input.purchaseId : null,
        factSetKey: input.trigger === 'PROVIDER_ELIGIBILITY_REACHED' ? buildFactSetKey(input.facts) : null,
        sourceChannel,
      },
      now,
    );
    return { triggerEventKey, ...ensured };
  }

  /**
   * Every ACTIVE eligibility set naming `fact` is re-read from the canonical
   * columns (never trusting the caller's "it is true now"); each set that is
   * complete gets its lifetime-unique event. An incomplete set gets nothing:
   * its event does not exist until the last fact lands (CMP-001 §8.3) —
   * and that last fact's channel is the event's.
   */
  private async raiseEligibility(
    tx: Prisma.TransactionClient,
    providerId: string,
    fact: CampaignEligibilityFact,
    sourceChannel: SourceChannel,
    now: Date,
  ): Promise<{ events: RaisedEvent[]; incompleteFactSetKeys: string[] }> {
    const sets = await this.repository.factSetsNaming(tx, fact);
    const events: RaisedEvent[] = [];
    const incompleteFactSetKeys: string[] = [];
    for (const set of sets) {
      const values = await this.registry.readAll(tx, providerId, set.facts);
      if (!set.facts.every((name) => values[name])) {
        incompleteFactSetKeys.push(set.factSetKey);
        continue;
      }
      events.push(
        await this.raise(tx, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', providerId, facts: set.facts }, sourceChannel, now),
      );
    }
    return { events, incompleteFactSetKeys };
  }

  /**
   * The durability rule of the file comment, mechanically. The only thing
   * this boundary does with an error is name it: a write conflict keeps its
   * P2034 for the caller's replay, everything else becomes the retryable
   * 503 — and in both cases the caller's transaction rolls back, event and
   * business write together. No savepoint, no fallback, no partial commit.
   */
  private async durable(work: (now: Date) => Promise<HookResult>): Promise<HookResult> {
    try {
      return await work(new Date());
    } catch (error) {
      if (isWriteConflictError(error)) {
        throw error;
      }
      this.logger.error(
        `Campaign event could not be made durable; the business transaction is not committed: ${describe(error)}`,
      );
      throw campaignEventNotDurable();
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

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The retryable refusal a hooked flow answers with when the pending event
 * could not be written, whatever stopped it. 503: nothing partial exists,
 * the business write did not happen, and the same request later is the
 * right response — a payment provider retries any non-2xx, an operator
 * presses the button again, the owner enters the code again.
 */
export function campaignEventNotDurable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    code: CAMPAIGN_EVENT_NOT_DURABLE,
    message: 'Kampanya olayı kaydedilemedi; işlem geri alındı. Lütfen tekrar deneyin.',
  });
}
