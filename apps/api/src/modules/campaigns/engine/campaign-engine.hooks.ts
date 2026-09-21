import { HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { type CampaignEligibilityFact, type CampaignTriggerEventStatus, Prisma, UserRole } from '@prisma/client';
import { isWriteConflictError } from '../../../common/serializable-transaction';
import { OPERATIONS_SETTINGS_ID } from '../../operations-settings/operations-settings.service';
import { CampaignEngineRepository, SAVEPOINT } from './campaign-engine.repository';
import { type CampaignFactSource, FactSourceRegistry, type FactWriter } from './fact-source-registry';
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
 * Failure rule inside stage A: a *campaign-side* runtime fault (a bug in
 * fact-set lookup, say) is contained under a savepoint and logged, and the
 * business transaction commits — the trigger's own write is worth more than
 * an evaluation that is not due yet. A *database* fault, though — the event
 * row could not be made durable — is not contained: "the payment settled but
 * the campaign event is certainly lost" is the one outcome ruled out, so the
 * caller's transaction fails with a retryable 503 and the provider redelivers
 * or the operator tries again. A serialization conflict is rethrown as
 * always, for the caller's `runSerializable` to replay.
 *
 * Writers register themselves here at boot (`registerFactWriter`), which is
 * what the activation gate reads: a version that depends on a source no
 * booted module raises cannot go ACTIVE (`FACT_SOURCE_UNAVAILABLE`).
 */

export const CAMPAIGN_EVENT_NOT_DURABLE = 'CAMPAIGN_EVENT_NOT_DURABLE';

export type AccountProofFact = Extract<CampaignEligibilityFact, 'EMAIL_VERIFIED' | 'PHONE_VERIFIED'>;

export type RaisedEvent = { triggerEventKey: string; id: string; status: CampaignTriggerEventStatus; created: boolean };

export type HookResult =
  | { outcome: 'CAMPAIGN_ENGINE_DISABLED' }
  /** The account is not a PROVIDER's, or has no profile: a customer's or an operator's proof is no campaign fact. */
  | { outcome: 'NOT_A_PROVIDER_FACT' }
  /** A campaign-side runtime fault, contained; the business write stands. */
  | { outcome: 'HOOK_ERROR'; error: string }
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

  /**
   * A genuine transition into APPROVED: the PROVIDER_APPROVED event itself,
   * plus — the fact having become true — every eligibility set that names it
   * and is now complete.
   */
  async providerApproved(tx: Prisma.TransactionClient, providerId: string): Promise<HookResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    return this.contained(tx, async (now) => {
      const events: RaisedEvent[] = [];
      events.push(await this.raise(tx, { trigger: 'PROVIDER_APPROVED', providerId }, now));
      const eligibility = await this.raiseEligibility(tx, providerId, 'PROVIDER_APPROVED', now);
      events.push(...eligibility.events);
      return { outcome: 'RAISED', events, incompleteFactSetKeys: eligibility.incompleteFactSetKeys } as const;
    });
  }

  /**
   * An account proof that just became true for `userId`. Resolved to the
   * provider profile the account owns; a CUSTOMER's or SUPER_ADMIN's proof,
   * or an account with no profile, produces no campaign fact at all.
   */
  async accountFactProven(tx: Prisma.TransactionClient, userId: string, fact: AccountProofFact): Promise<HookResult> {
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
    return this.contained(tx, async (now) => {
      const eligibility = await this.raiseEligibility(tx, profile.id, fact, now);
      return { outcome: 'RAISED', ...eligibility } as const;
    });
  }

  /** A purchase this transaction has just written PAID through a verified settlement path. */
  async packagePaymentSucceeded(tx: Prisma.TransactionClient, providerId: string, purchaseId: string): Promise<HookResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    return this.contained(tx, async (now) => ({
      outcome: 'RAISED' as const,
      events: [await this.raise(tx, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId, purchaseId }, now)],
      incompleteFactSetKeys: [],
    }));
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async raise(tx: Prisma.TransactionClient, input: CampaignTriggerInput, now: Date): Promise<RaisedEvent> {
    const triggerEventKey = buildTriggerEventKey(input);
    const ensured = await this.repository.ensurePendingEvent(
      tx,
      {
        triggerEventKey,
        trigger: input.trigger,
        providerId: input.providerId,
        purchaseId: input.trigger === 'PACKAGE_PAYMENT_SUCCEEDED' ? input.purchaseId : null,
        factSetKey: input.trigger === 'PROVIDER_ELIGIBILITY_REACHED' ? buildFactSetKey(input.facts) : null,
      },
      now,
    );
    return { triggerEventKey, ...ensured };
  }

  /**
   * Every ACTIVE eligibility set naming `fact` is re-read from the canonical
   * columns (never trusting the caller's "it is true now"); each set that is
   * complete gets its lifetime-unique event. An incomplete set gets nothing:
   * its event does not exist until the last fact lands (CMP-001 §8.3).
   */
  private async raiseEligibility(
    tx: Prisma.TransactionClient,
    providerId: string,
    fact: CampaignEligibilityFact,
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
      events.push(await this.raise(tx, { trigger: 'PROVIDER_ELIGIBILITY_REACHED', providerId, facts: set.facts }, now));
    }
    return { events, incompleteFactSetKeys };
  }

  /**
   * The failure rule of the file comment, mechanically: a database fault or a
   * write conflict propagates; anything else is rolled back to the savepoint,
   * logged without the payload, and reported as HOOK_ERROR while the caller's
   * transaction goes on to commit.
   */
  private async contained(tx: Prisma.TransactionClient, work: (now: Date) => Promise<HookResult>): Promise<HookResult> {
    await this.repository.savepoint(tx, SAVEPOINT.fact);
    try {
      const value = await work(new Date());
      await this.repository.release(tx, SAVEPOINT.fact);
      return value;
    } catch (error) {
      if (isWriteConflictError(error)) {
        throw error;
      }
      if (isDatabaseFault(error)) {
        this.logger.error(`Campaign event could not be made durable; the business transaction is not committed: ${describe(error)}`);
        throw campaignEventNotDurable();
      }
      await this.repository.rollbackTo(tx, SAVEPOINT.fact);
      const message = describe(error);
      this.logger.error(`Campaign hook failed and was contained (business write stands): ${message}`);
      return { outcome: 'HOOK_ERROR', error: message };
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

/**
 * A Prisma request error of any kind (known, unknown, Rust panic,
 * initialization) — or one that crossed a module boundary and kept only its
 * shape. After such an error the transaction may be unusable anyway; what
 * matters is that the event insert did not happen.
 */
function isDatabaseFault(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientInitializationError
  ) {
    return true;
  }
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  return (typeof name === 'string' && name.startsWith('PrismaClient')) || (typeof code === 'string' && /^P\d{4}$/.test(code));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The retryable refusal a hooked flow answers with when the pending event
 * could not be written. 503: nothing partial exists, the business write did
 * not happen, and the same request later is the right response — a payment
 * provider retries any non-2xx, an operator presses the button again.
 */
export function campaignEventNotDurable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    code: CAMPAIGN_EVENT_NOT_DURABLE,
    message: 'Kampanya olayı kaydedilemedi; işlem geri alındı. Lütfen tekrar deneyin.',
  });
}
