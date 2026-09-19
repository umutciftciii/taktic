import { Injectable } from '@nestjs/common';
import type { CampaignEligibilityFact, Prisma } from '@prisma/client';
import { OPERATIONS_SETTINGS_ID } from '../../operations-settings/operations-settings.service';
import type { CampaignTriggerInput } from './trigger-event-key';

/**
 * The campaign engine's boundary (CMP-002 S2A).
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
 */

export type EngineInput = CampaignTriggerInput & {
  /** PROVIDER_APPROVED only: the raising write was a genuine transition into APPROVED. */
  approvalTransition?: boolean;
};

export type EngineDisabledResult = { outcome: 'CAMPAIGN_ENGINE_DISABLED' };

export type EngineResult = EngineDisabledResult;

export type FactResult = EngineDisabledResult;

@Injectable()
export class CampaignEngineService {
  async evaluate(tx: Prisma.TransactionClient, _input: EngineInput): Promise<EngineResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    throw new Error('not implemented');
  }

  async onProviderFact(
    tx: Prisma.TransactionClient,
    _providerId: string,
    _fact: CampaignEligibilityFact,
  ): Promise<FactResult> {
    if (!(await this.isEnabled(tx))) {
      return { outcome: 'CAMPAIGN_ENGINE_DISABLED' };
    }
    throw new Error('not implemented');
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
