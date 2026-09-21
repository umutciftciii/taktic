import type { CampaignRuleError } from '../../lib/api';

/** What the lifecycle panel gets back from its server action. */
export type CampaignLifecycleState = {
  status: 'idle' | 'error';
  message: string | null;
  /** Activation refusals, field by field (FACT_SOURCE_UNAVAILABLE, LIMIT_BELOW_CONSUMED, …). */
  errors: CampaignRuleError[];
};

export const IDLE_CAMPAIGN_LIFECYCLE_STATE: CampaignLifecycleState = { status: 'idle', message: null, errors: [] };
