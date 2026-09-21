import { ConflictException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { type CampaignEligibilityFact, type Prisma, UserRole } from '@prisma/client';
import { CampaignEngineService, type EngineResult, type FactResult } from './campaign-engine.service';
import { type CampaignFactSource, FactSourceRegistry, type FactWriter } from './fact-source-registry';

/**
 * The only way a business flow reaches the campaign engine (CMP-002 S2B2).
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
 * Every hook is a no-op read of one settings row while the engine is off:
 * the engine answers CAMPAIGN_ENGINE_DISABLED before touching anything, so a
 * default-off engine costs the hooked flows nothing and writes nothing.
 *
 * With the engine on, the hook's contract to its caller is: **a committed
 * business write implies a committed evaluation.** Serialization conflicts
 * propagate as P2034 and the caller's `runSerializable` replays the whole
 * transaction, evaluation included. An engine fault (ENGINE_ERROR — a
 * definition the validator refuses, a purchase the engine cannot read) is
 * not swallowed: the hook throws, the caller's transaction rolls back, and
 * the caller answers with a retryable 409. A payment is then not marked
 * PROCESSED and the provider redelivers; an approval or a proof is not
 * written and the operator or the owner tries again — after an operator has
 * paused or ended the campaign at fault, which is always possible. "The
 * payment settled but the campaign event was lost" and "the proof was
 * written but the grant was silently skipped" are both ruled out by
 * construction. This is a deliberate departure from CMP-001 §3.5, which let
 * the trigger transaction commit over an engine fault; the S2B2 brief rules
 * that a silent loss is worse than a retry.
 *
 * Writers register themselves here at boot (`registerFactWriter`), which is
 * what the activation gate reads: a version that depends on a source no
 * booted module raises cannot go ACTIVE (`FACT_SOURCE_UNAVAILABLE`).
 */

export const CAMPAIGN_ENGINE_FAILED = 'CAMPAIGN_ENGINE_FAILED';

export type AccountProofFact = Extract<CampaignEligibilityFact, 'EMAIL_VERIFIED' | 'PHONE_VERIFIED'>;

export type ProviderApprovedHookResult = {
  event: EngineResult;
  eligibility: FactResult;
};

export type AccountFactHookResult =
  /** The account is not a PROVIDER's, or has no profile: a customer's or an operator's proof is no campaign fact. */
  | { outcome: 'NOT_A_PROVIDER_FACT' }
  | { outcome: 'EVALUATED'; providerId: string; eligibility: FactResult };

@Injectable()
export class CampaignEngineHooks {
  private readonly logger = new Logger(CampaignEngineHooks.name);

  constructor(
    @Inject(CampaignEngineService) private readonly engine: CampaignEngineService,
    @Inject(FactSourceRegistry) private readonly registry: FactSourceRegistry,
  ) {}

  /** Called once by each writer module at boot; see FactSourceRegistry. */
  registerFactWriter(source: CampaignFactSource, writer: FactWriter): void {
    this.registry.register(source, writer);
  }

  /**
   * A genuine transition into APPROVED: the PROVIDER_APPROVED *event* is
   * evaluated first (CMP-001 §3.5 order), then the PROVIDER_APPROVED *fact*
   * is offered to every eligibility set that names it.
   */
  async providerApproved(tx: Prisma.TransactionClient, providerId: string): Promise<ProviderApprovedHookResult> {
    const event = this.settled(
      await this.engine.evaluate(tx, { trigger: 'PROVIDER_APPROVED', providerId, approvalTransition: true }),
      `PROVIDER_APPROVED:${providerId}`,
    );
    const eligibility = this.settled(
      await this.engine.onProviderFact(tx, providerId, 'PROVIDER_APPROVED'),
      `PROVIDER_APPROVED fact of ${providerId}`,
    );
    return { event, eligibility };
  }

  /**
   * An account proof that just became true for `userId`. Resolved to the
   * provider profile the account owns; a CUSTOMER's or SUPER_ADMIN's proof,
   * or an account with no profile, produces no campaign fact at all.
   */
  async accountFactProven(
    tx: Prisma.TransactionClient,
    userId: string,
    fact: AccountProofFact,
  ): Promise<AccountFactHookResult> {
    const profile = await tx.providerProfile.findUnique({
      where: { userId },
      select: { id: true, user: { select: { role: true } } },
    });
    if (!profile || profile.user?.role !== UserRole.PROVIDER) {
      return { outcome: 'NOT_A_PROVIDER_FACT' };
    }
    const eligibility = this.settled(
      await this.engine.onProviderFact(tx, profile.id, fact),
      `${fact} fact of ${profile.id}`,
    );
    return { outcome: 'EVALUATED', providerId: profile.id, eligibility };
  }

  /** A purchase this transaction has just written PAID through a verified settlement path. */
  async packagePaymentSucceeded(
    tx: Prisma.TransactionClient,
    providerId: string,
    purchaseId: string,
  ): Promise<EngineResult> {
    return this.settled(
      await this.engine.evaluate(tx, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId, purchaseId }),
      `PACKAGE_PAYMENT_SUCCEEDED:${purchaseId}`,
    );
  }

  /** ENGINE_ERROR is the one answer a hooked caller may not commit over. */
  private settled<T extends { outcome: string }>(result: T, what: string): T {
    if (result.outcome === 'ENGINE_ERROR') {
      const error = (result as { error?: string }).error ?? 'unknown';
      this.logger.error(`Campaign evaluation of ${what} failed; the caller's transaction is rolled back: ${error}`);
      throw campaignEngineFailed();
    }
    return result;
  }
}

/**
 * The retryable refusal a hooked flow answers with when the engine could not
 * evaluate. 409 like CONCURRENT_MODIFICATION, and for the same reason: the
 * business write did not happen, nothing partial exists, and trying again
 * — after the offending campaign is paused — is the right response. A
 * payment provider retries any non-2xx; an operator presses the button again.
 */
export function campaignEngineFailed() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CAMPAIGN_ENGINE_FAILED,
    message:
      'Kampanya değerlendirmesi tamamlanamadı; işlem geri alındı. Sorumlu kampanyayı duraklatıp tekrar deneyin.',
  });
}
