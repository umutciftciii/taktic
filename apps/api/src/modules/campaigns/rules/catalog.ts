import catalog from '@taktic/shared/campaign-rules.json';

/**
 * The one catalogue the campaign rule language is made of, read from
 * `packages/shared/campaign-rules.json` — the same file the admin panel reads
 * to build its form. JSON rather than a TypeScript export because this process
 * cannot `require` `@taktic/shared` itself (see common/service-request-limits.ts).
 *
 * Everything the validator accepts is listed here: the three triggers, the
 * three status facts, the ten condition types with their fixed argument
 * shapes, the single benefit type, the four limits, the single stack policy
 * and the closed set of error codes. There is no per-campaign code anywhere:
 * a campaign is a selection from this catalogue and nothing else.
 */

export type ArgumentSpec =
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'enumList'; values: readonly string[]; min: number; max: number }
  | { kind: 'slugList'; min: number; max: number };

export type ConditionSpec = {
  triggers: readonly string[];
  /** Triggers on which this condition is refused with USE_ELIGIBILITY_TRIGGER (CMP-001 §8). */
  useEligibilityTriggerFor?: readonly string[];
  /** The eligibility fact this condition duplicates when both are present. */
  fact?: string;
  args: Readonly<Record<string, ArgumentSpec>>;
};

type Bounds = { min: number; max: number };

export const CAMPAIGN_RULES_SCHEMA_VERSION: number = catalog.schemaVersion;
export const CAMPAIGN_TRIGGERS: readonly string[] = catalog.triggers;
export const CAMPAIGN_ELIGIBILITY_TRIGGER: string = catalog.eligibilityTrigger;
export const CAMPAIGN_FACTS: readonly string[] = catalog.facts;
export const CAMPAIGN_FACT_SET: Bounds = catalog.factSet;
export const CAMPAIGN_GROUP_LIMITS: { maxAll: number; maxAny: number } = catalog.groups;
export const CAMPAIGN_CONDITIONS: Readonly<Record<string, ConditionSpec>> =
  catalog.conditions as Readonly<Record<string, ConditionSpec>>;
export const CAMPAIGN_BENEFIT: {
  types: readonly string[];
  credits: Bounds;
  expiresInDays: Bounds;
} = catalog.benefit;
export const CAMPAIGN_LIMITS: Readonly<Record<string, Bounds & { required: boolean }>> =
  catalog.limits;
export const CAMPAIGN_STACK_POLICIES: readonly string[] = catalog.stackPolicies;
export const CAMPAIGN_PRIORITY: Bounds & { default: number } = catalog.priority;
export const CAMPAIGN_RULE_ERROR_CODE_LIST: readonly string[] = catalog.errorCodes;

export type CampaignTriggerCode = (typeof catalog.triggers)[number];
export type CampaignFactCode = (typeof catalog.facts)[number];
export type CampaignConditionCode = keyof typeof catalog.conditions;
export type CampaignBenefitCode = (typeof catalog.benefit.types)[number];
export type CampaignStackPolicyCode = (typeof catalog.stackPolicies)[number];
