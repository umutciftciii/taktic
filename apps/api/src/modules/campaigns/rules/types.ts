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

/**
 * CAMPAIGN-CREDIT-POLICY-001. How a credit benefit's promo credit is spent and
 * whether an admin deduction may take it. Part of the immutable version.
 */
export type CampaignCreditPolicy = {
  spendPriority: 'PROMO_FIRST' | 'PAID_FIRST';
  adminDeductPolicy: 'PAID_ONLY' | 'ALLOW_PROMO';
};

export type CampaignBenefit = {
  type: string;
  credits: number;
  expiresInDays: number;
  /** Required for a credit-producing type, absent for any other (schema v2). */
  creditPolicy?: CampaignCreditPolicy;
};

export type CampaignDefinition = {
  schemaVersion: 2;
  trigger: string;
  eligibility?: { facts: string[] };
  conditions: { all: Array<CampaignCondition | CampaignAnyGroup> };
  benefit: CampaignBenefit;
  limits: {
    maxRedemptionsPerProvider: number;
    maxRedemptionsGlobal: number | null;
    maxRedemptionsPerDay: number | null;
    budgetCredits: number | null;
    /** CMP-003 S3: revokes per UTC day before the campaign pauses itself; null = no threshold. */
    maxRevokesPerDay: number | null;
  };
  window: { startAt: string | null; endAt: string | null };
  stackPolicy: string;
  priority: number;
  /**
   * CMP-006 PR-D: WEB | MOBILE | ALL. A definition stored before the field
   * existed has none and normalises to ALL — what it always meant.
   */
  channel: string;
};

/** What the panel shows beside a valid definition, and what the version row denormalises. */
export type CampaignDefinitionSummary = {
  trigger: string;
  factSetKey: string | null;
  eligibilityFacts: string[];
  conditionCount: number;
  benefitCredits: number;
  benefitExpiresInDays: number;
  channel: string;
  /** CAMPAIGN-CREDIT-POLICY-001: null for a benefit that produces no credit. */
  creditPolicy: CampaignCreditPolicy | null;
};

export function isAnyGroup(entry: CampaignCondition | CampaignAnyGroup): entry is CampaignAnyGroup {
  return 'any' in entry;
}
