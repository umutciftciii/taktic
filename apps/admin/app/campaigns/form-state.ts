import type { CampaignRuleError, CampaignValidationResponse } from '../../lib/api';

/** What the builder form gets back from its server action. */
export type CampaignFormState = {
  status: 'idle' | 'valid' | 'invalid' | 'error';
  errors: CampaignRuleError[];
  summary: CampaignValidationResponse['summary'];
  message: string | null;
};

export const IDLE_CAMPAIGN_FORM_STATE: CampaignFormState = {
  status: 'idle',
  errors: [],
  summary: null,
  message: null,
};
