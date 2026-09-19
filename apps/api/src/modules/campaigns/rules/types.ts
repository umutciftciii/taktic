/**
 * The validated shape of a campaign definition, schema version 1.
 *
 * These types describe what comes *out* of the validator. Nothing in the
 * application constructs one by hand or reads one that did not pass through
 * `validateCampaignDefinition` — the stored `CampaignVersion.definition` is
 * re-parsed on every read for the same reason (CMP-001 §2.2).
 */

export type CampaignCondition = {
  type: string;
  [argument: string]: unknown;
};

export type CampaignAnyGroup = { any: CampaignCondition[] };

export type CampaignDefinition = {
  schemaVersion: 1;
  trigger: string;
  eligibility?: { facts: string[] };
  conditions: { all: Array<CampaignCondition | CampaignAnyGroup> };
  benefit: { type: string; credits: number; expiresInDays: number };
  limits: {
    maxRedemptionsPerProvider: number;
    maxRedemptionsGlobal: number | null;
    maxRedemptionsPerDay: number | null;
    budgetCredits: number | null;
  };
  window: { startAt: string | null; endAt: string | null };
  stackPolicy: string;
  priority: number;
};

/** What the panel shows beside a valid definition, and what the version row denormalises. */
export type CampaignDefinitionSummary = {
  trigger: string;
  factSetKey: string | null;
  eligibilityFacts: string[];
  conditionCount: number;
  benefitCredits: number;
  benefitExpiresInDays: number;
};

export function isAnyGroup(entry: CampaignCondition | CampaignAnyGroup): entry is CampaignAnyGroup {
  return 'any' in entry;
}
