import type { CampaignEligibilityFact } from '@prisma/client';

/**
 * The identity of a business event, independent of any campaign (CMP-001 §12.2).
 *
 * Three shapes, none carrying a timestamp:
 *
 *   PROVIDER_APPROVED:<providerId>
 *   PACKAGE_PAYMENT_SUCCEEDED:<purchaseId>
 *   PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>
 *
 * A second approval after a suspension, a re-delivered webhook and a proof
 * written again all produce the key they produced the first time, which is
 * what lets `CampaignTriggerEvent.triggerEventKey` be globally unique and
 * `CampaignRedemption (campaignId, triggerEventKey)` refuse a repeat.
 */

export type CampaignTriggerInput =
  | { trigger: 'PROVIDER_APPROVED'; providerId: string }
  | { trigger: 'PACKAGE_PAYMENT_SUCCEEDED'; providerId: string; purchaseId: string }
  | { trigger: 'PROVIDER_ELIGIBILITY_REACHED'; providerId: string; facts: readonly CampaignEligibilityFact[] };

export const FACT_SET_SEPARATOR = '+';

/**
 * The canonical name of a fact set: sorted, joined with `+`. Identical to
 * what the S1 validator stores in `CampaignVersion.factSetKey`, so the engine
 * can match an event to a version by string equality.
 */
export function buildFactSetKey(facts: readonly CampaignEligibilityFact[]): string {
  if (facts.length === 0) {
    throw new Error('An eligibility transition needs at least one fact');
  }
  return [...facts].sort().join(FACT_SET_SEPARATOR);
}

export function buildTriggerEventKey(input: CampaignTriggerInput): string {
  switch (input.trigger) {
    case 'PROVIDER_APPROVED':
      return `${input.trigger}:${input.providerId}`;
    case 'PACKAGE_PAYMENT_SUCCEEDED':
      return `${input.trigger}:${input.purchaseId}`;
    case 'PROVIDER_ELIGIBILITY_REACHED':
      return `${input.trigger}:${buildFactSetKey(input.facts)}:${input.providerId}`;
  }
}
