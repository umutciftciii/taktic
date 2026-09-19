import type { OfferPackageType, PackagePurchaseKind, ProviderStatus } from '@prisma/client';
import { CAMPAIGN_CONDITIONS } from '../rules/catalog';
import { isAnyGroup, type CampaignCondition, type CampaignDefinition } from '../rules/types';

/**
 * The pure half of rule evaluation (CMP-001 §2.2).
 *
 * A definition that passed the validator, a bag of facts the engine read
 * inside the trigger transaction from the canonical sources, and a verdict.
 * No I/O, no clock of its own (`now` is a fact), and no knowledge of which
 * campaign is asking. Every condition type in the catalogue has one branch
 * here; a type that has none did not come through the validator, and the
 * evaluator says so rather than guessing.
 */

export type ProviderFacts = {
  providerId: string;
  /** The owning account, when the profile has one. */
  userId: string | null;
  status: ProviderStatus;
  approvedAt: Date | null;
  /** From the owning account; null when the profile has no account (guest application). */
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  /** Any CampaignRedemption with trigger PROVIDER_APPROVED for this provider, in any status. */
  hasPriorApprovalRedemption: boolean;
  /** Any CampaignRedemption with status REVOKED for this provider. */
  hasRevokedRedemption: boolean;
};

export type PurchaseFacts = {
  purchaseId: string;
  kind: PackagePurchaseKind;
  packageSlug: string | null;
  packageType: OfferPackageType | null;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  /** Another purchase of this provider with status PAID and kind OFFER_PACKAGE exists. */
  hasOtherPaidOfferPurchase: boolean;
};

export type EvaluationFacts = {
  now: Date;
  provider: ProviderFacts;
  /** Present on PACKAGE_PAYMENT_SUCCEEDED. */
  purchase?: PurchaseFacts;
  /** True when the raising write was a genuine non-APPROVED → APPROVED transition. */
  approvalTransition?: boolean;
};

export type ConditionVerdict = { passed: true } | { passed: false; failedCondition: string };

const DAY_MS = 86_400_000;

export function evaluateConditions(definition: CampaignDefinition, facts: EvaluationFacts): ConditionVerdict {
  for (const entry of definition.conditions.all) {
    if (isAnyGroup(entry)) {
      if (!entry.any.some((condition) => holds(condition, facts))) {
        return { passed: false, failedCondition: 'any' };
      }
      continue;
    }
    if (!holds(entry, facts)) {
      return { passed: false, failedCondition: entry.type };
    }
  }
  return { passed: true };
}

function holds(condition: CampaignCondition, facts: EvaluationFacts): boolean {
  const { provider, purchase } = facts;
  switch (condition.type) {
    case 'FIRST_PROVIDER_APPROVAL':
      return facts.approvalTransition === true && !provider.hasPriorApprovalRedemption;
    case 'EMAIL_VERIFIED':
      return provider.emailVerifiedAt !== null;
    case 'PHONE_VERIFIED':
      return provider.phoneVerifiedAt !== null;
    case 'FIRST_SUCCESSFUL_PAID_PURCHASE':
      return purchase !== undefined && !purchase.hasOtherPaidOfferPurchase;
    case 'PACKAGE_SLUG_IN':
      return purchase?.packageSlug != null && stringList(condition.slugs).includes(purchase.packageSlug);
    case 'PACKAGE_TYPE_IN':
      return purchase?.packageType != null && stringList(condition.types).includes(purchase.packageType);
    case 'PURCHASE_KIND_IN':
      return purchase !== undefined && stringList(condition.kinds).includes(purchase.kind);
    case 'MIN_PAID_AMOUNT':
      return (
        purchase !== undefined &&
        purchase.currencySnapshot === condition.currency &&
        purchase.priceAmountSnapshot >= Number(condition.minor)
      );
    case 'NO_PRIOR_REVOCATION':
      return !provider.hasRevokedRedemption;
    case 'PROVIDER_APPROVED_WITHIN_DAYS':
      return (
        provider.approvedAt !== null &&
        provider.approvedAt.getTime() >= facts.now.getTime() - Number(condition.days) * DAY_MS
      );
    default:
      // Every catalogue entry is handled above; reaching here means the
      // catalogue grew without the evaluator, or the definition bypassed the
      // validator. Either is a programming error, not a business outcome.
      throw new Error(
        `Campaign condition "${String(condition.type)}" has no evaluator` +
          (condition.type in CAMPAIGN_CONDITIONS ? ' (catalogue entry without a branch)' : ' (unknown to the catalogue)'),
      );
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
