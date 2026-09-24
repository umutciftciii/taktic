import type { ServiceAreaScope } from '@taktic/shared';
import { urgencyLabel as sharedUrgencyLabel } from '@taktic/shared';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
// Re-exported by the `export *` further down; imported by name as well
// because a re-export does not put the names in this module's own scope.
import type { ReviewModerationAction, ReviewReportReason, ReviewReportResolution } from './reviews';
import type { BusinessRegistrationView } from './business-registration';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const CATEGORY_ICON_KEYS = [
  'snowflake',
  'flame',
  'bolt',
  'drop',
  'brush',
  'sparkles',
  'truck',
  'box',
  'wrench',
  'tool',
  'book',
] as const;

export type CategoryIconKey = (typeof CATEGORY_ICON_KEYS)[number];

/**
 * What a category is in the tree.
 *
 * GROUP is navigation: it holds children and nothing else. LEAF is a service —
 * the only kind a request, an offer or a provider's service list may point at.
 * ROUTER is an entry point whose single question sends the customer on to the
 * leaf they actually meant.
 */
export type CategoryKind = 'GROUP' | 'LEAF' | 'ROUTER';

/**
 * Operational readiness, which is not the same thing as visibility.
 *
 * DRAFT is visible here and nowhere else. ACTIVE is public and matchable.
 * INACTIVE is closed to new requests and new provider selections while
 * everything already recorded stays readable.
 */
export type CategoryStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE';

/**
 * How far an unreleased service has got towards being one.
 *
 * Derived by the API on every read from the category, its approved-provider
 * count and its price — never stored, so it cannot go stale. `null` for groups,
 * routers and closed categories, which the question does not apply to.
 */
export type CategorySupplyStatus = 'EMPTY' | 'SUPPLY_READY' | 'LAUNCH_READY' | 'LIVE';

export type Category = {
  id: string;
  parentId: string | null;
  parent?: { id: string; name: string; slug: string } | null;
  kind: CategoryKind;
  status: CategoryStatus;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  coverImageUrl: string | null;
  iconKey: CategoryIconKey | string | null;
  isActive: boolean;
  sortOrder: number;
  /**
   * Credits a provider spends per offer in this category. `null` means the price
   * has never been set — such a category cannot receive offers and is flagged in
   * the admin list.
   */
  offerCreditCost: number | null;
  /**
   * Whether providers may sign themselves up for this service. Only editable on
   * a draft: a live service is always open, and the API refuses a write that
   * says otherwise.
   */
  providerEnrollmentOpen: boolean;
  /** Whether this category may be sold inside a CATEGORY_UNLIMITED package. */
  unlimitedPackageEligible: boolean;
  /** Present on the operator view only. See CategorySupplyStatus. */
  supplyStatus?: CategorySupplyStatus | null;
  _count?: {
    questions: number;
    children?: number;
    /**
     * Approved providers attached to this category — never pending or suspended
     * ones, which cannot be shown a request. Zero means a released category
     * would publish requests nobody can answer, which is why the release
     * readiness rules treat it as a blocker.
     */
    providers?: number;
    /**
     * Provider application invitations for this category that are still usable
     * — not spent, not withdrawn, not expired.
     *
     * Deliberately **not** a readiness criterion. It says somebody has been
     * approached about this service, which is progress towards supply and not
     * supply: a draft with three live invitations and no approved provider is
     * exactly as unready as one with none. {@link releaseBlockers} never reads
     * it, and the screens that show it say so in as many words.
     */
    providerInvites?: number;
  };
  questions?: Question[];
};

/**
 * The company's public details, as an operator maintains them.
 *
 * Deliberately narrow. Nothing about the e-mail transport reaches this type —
 * no key, no sender address, no provider name — because the endpoint behind it
 * does not return any, and an admin screen that could read a credential would
 * be a way to take one with an admin session rather than a shell.
 */
export type CompanySettingsIssue =
  | 'NOT_CONFIGURED'
  | 'LEGAL_NAME_MISSING'
  | 'SUPPORT_EMAIL_MISSING'
  | 'SUPPORT_EMAIL_NOT_DELIVERABLE';

export type CompanySettings = {
  configured: boolean;
  legalName: string | null;
  supportEmail: string | null;
  postalAddress: string | null;
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null } | null;
  /** Why the footer cannot be published yet. Empty means it can. */
  issues: CompanySettingsIssue[];
};

/** What each issue means, in the words the operator has to act on. */
export const COMPANY_SETTINGS_ISSUE_LABELS: Record<CompanySettingsIssue, string> = {
  NOT_CONFIGURED:
    'Şirket bilgileri hiç kaydedilmemiş. Gerçek e-posta taşıyıcısı açıkken tasarımlı e-postalar gönderilmez.',
  LEGAL_NAME_MISSING: 'Yasal unvan eksik veya yalnızca ürün adını içeriyor.',
  SUPPORT_EMAIL_MISSING: 'Destek e-postası eksik.',
  SUPPORT_EMAIL_NOT_DELIVERABLE:
    'Destek e-postası örnek/ayrılmış bir alan adında; bu adrese e-posta ulaşamaz.',
};

export type QuestionType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'DATE'
  | 'IMAGE';

export type QuestionOption = {
  key: string;
  label: string;
};

/**
 * The request column a question is bound to instead of an answer row.
 *
 * A bound question does not add a field to the form: it labels one the request
 * already has and can make it mandatory for this category. Nothing is stored
 * twice, so the address provider matching reads is the address the customer
 * typed — not a copy that can drift from it.
 */
export type QuestionSystemField = 'ADDRESS' | 'BUDGET' | 'DESCRIPTION' | 'PREFERRED_DATE';

/**
 * How a condition compares the expected answers against what the customer
 * chose.
 *
 * ANY — at least one of them. ALL — every one of them. The two differ only when
 * the source question lets the customer choose more than one answer, which is
 * why the API refuses ALL on any other kind of source.
 */
export type QuestionConditionMatchMode = 'ANY' | 'ALL';

/** "Show this question only when <sourceQuestionKey> answered these." */
export type QuestionCondition = {
  sourceQuestionKey: string;
  sourceQuestionLabel: string;
  expectedValues: string[];
  /** Absent means ANY — what every rule stored before the mode existed meant. */
  matchMode?: QuestionConditionMatchMode;
};

/** One option of a routing question, and the service it leads to. */
export type QuestionRouterRule = {
  optionKey: string;
  targetCategoryName: string;
  targetCategorySlug: string;
};

export type Question = {
  id: string;
  categoryId: string;
  key: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  isRequired: boolean;
  options: QuestionOption[] | null;
  systemField: QuestionSystemField | null;
  isRouter: boolean;
  conditions?: QuestionCondition[];
  routerRules?: QuestionRouterRule[];
  sortOrder: number;
  isActive: boolean;
};

export type ServiceRequestStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'MATCHED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

export type QualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';

export type QualityBreakdownComponent = {
  points: number;
  max: number;
  passed: boolean;
};

export type QualityScoreBreakdown = Record<string, QualityBreakdownComponent>;

export type ServiceRequestAnswer = {
  id: string;
  questionKey: string;
  questionLabel: string;
  questionType: string;
  value: unknown;
  createdAt: string;
};

export type ServiceRequest = {
  id: string;
  requestNumber: string | null;
  customerId: string | null;
  status: ServiceRequestStatus;
  qualityScore: number;
  qualityLabel: QualityLabel;
  qualityScoreBreakdown: QualityScoreBreakdown | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  city: string;
  district: string;
  neighborhood: string | null;
  addressNote: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  preferredDate: string | null;
  /** Null on a legacy single date; the range's last day otherwise. */
  preferredDateEnd?: string | null;
  urgency: string | null;
  description: string | null;
  moderatedAt: string | null;
  moderationNote: string | null;
  rejectionReason: string | null;
  /** null until the customer proves control of customerPhone with a one-time code. */
  phoneVerifiedAt: string | null;
  /**
   * When moderation approved the request — the clock the 14-day expiry and the
   * day-7 reminder run on. null on requests approved before the field existed;
   * those are never touched by either scheduler.
   */
  approvedAt: string | null;
  /** When the day-7 "no offers yet" reminder was claimed. Written at most once. */
  reminderSentAt: string | null;
  matchedOfferId: string | null;
  matchedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
  category: {
    id: string;
    name: string;
    slug: string;
  };
  customer?: {
    id: string;
    email: string | null;
    phone: string | null;
    name: string | null;
  } | null;
  answers?: ServiceRequestAnswer[];
  offersCount?: number;
  _count?: {
    offers: number;
  };
};

export type ProviderStatus = 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export type ProviderServiceCategory = {
  id: string;
  category: {
    id: string;
    name: string;
    slug: string;
    /**
     * Carried only on the operator's reads of a provider. A binding to a DRAFT
     * category exists solely so the release readiness count is real before the
     * category is released, and this screen is the only one that may name it —
     * every other projection of a provider drops those bindings entirely.
     */
    kind: CategoryKind;
    status: CategoryStatus;
  };
};

/**
 * One row of the service list an operator manages, with the one fact the
 * screen cannot derive on its own.
 *
 * `countsForRelease` is false whenever the provider is not APPROVED. The
 * readiness figure behind a release decision counts approved providers only, so
 * an operator who attaches a pending application to a draft has to be told, on
 * the spot, that the number they were trying to move did not move.
 */
export type AdminProviderServiceCategory = ProviderServiceCategory & {
  categoryId: string;
  createdAt: string;
  countsForRelease: boolean;
};

export type AdminProviderServiceCategories = {
  providerId: string;
  providerStatus: ProviderStatus;
  serviceCategories: AdminProviderServiceCategory[];
};

export type ProviderServiceArea = {
  id: string;
  /** Derived by the API from the levels below; a client never sends it. */
  scope: ServiceAreaScope;
  city: string;
  district: string | null;
  neighborhood: string | null;
};

export type ProviderRecentOffer = {
  id: string;
  offerNumber?: string | null;
  status: OfferStatus;
  priceAmount: number;
  currency: string;
  submittedAt: string;
  request: {
    id: string;
    requestNumber?: string | null;
    city: string;
    district: string;
    category: {
      id: string;
      name: string;
      slug: string;
    };
  };
};

export type ProviderRecentPackagePurchase = {
  id: string;
  purchaseNumber?: string | null;
  status: PackagePurchaseStatus;
  packageNameSnapshot: string;
  creditAmountSnapshot: number;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  createdAt: string;
  paidAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  refundedAt: string | null;
};

export type ProviderProfile = {
  id: string;
  userId: string | null;
  businessName: string;
  contactName: string;
  phone: string;
  email: string | null;
  /** The unverified legacy pair; the number arrives masked only (CMP-006 PR-C). Absent on the list. */
  taxType: string | null;
  taxNumberMasked?: string | null;
  /** CMP-006 PR-C: type and masked number; "UNSPECIFIED" for a legacy record. */
  businessRegistration?: BusinessRegistrationView;
  city: string;
  district: string;
  addressNote: string | null;
  description: string | null;
  status: ProviderStatus;
  moderationNote: string | null;
  rejectionReason: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    email: string | null;
    phone: string | null;
    name: string | null;
    role: 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER';
  } | null;
  claimedAt: string | null;
  serviceCategories: ProviderServiceCategory[];
  serviceAreas: ProviderServiceArea[];
  creditBalance?: number;
  activeOffersCount?: number;
  totalOffersCount?: number;
  packagePurchasesCount?: number;
  recentOffers?: ProviderRecentOffer[];
  recentPackagePurchases?: ProviderRecentPackagePurchase[];
  claim?: ProviderClaimSummary;
  claimEnabled?: boolean;
};

export type ProviderClaimInvitationState = 'ACTIVE' | 'USED' | 'EXPIRED';

/**
 * Everything the admin screens may know about a claim.
 *
 * Note what is absent: the token, the claim URL, and the applicant's address in
 * any form. The application's own contact address is already shown on the
 * detail screen from the profile itself — this block is about ownership, not
 * about who to write to.
 */
export type ProviderClaimSummary = {
  canInvite: boolean;
  blockedCode: string | null;
  claimedAt: string | null;
  ownership: 'UNCLAIMED' | 'CLAIMED' | 'OWNED';
  lastInvitation: {
    createdAt: string;
    expiresAt: string;
    state: ProviderClaimInvitationState;
    byAdmin: boolean;
  } | null;
};

export type ProviderClaimInviteResult = {
  status: 'ISSUED';
  expiresAt: string;
  delivery: 'PENDING' | 'SENT' | 'FAILED';
};

/**
 * Why an operator may no longer act on a provider application invitation.
 *
 * ACTIVE is the only state the link works in. The other three are how it
 * stopped working, and they are an operator's to see — whoever holds the link
 * is told nothing but "not found", whichever of the three it is.
 */
export type ProviderInviteState = 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';

/**
 * One row of a category's invitation history.
 *
 * Note what is absent, and note that no other type in this file can supply it:
 * the token and the URL that contains it. The API returns those exactly once,
 * in the response to the request that created the invitation, and no later read
 * of any endpoint can produce them again — so this screen cannot show an
 * operator a link they have lost, and neither can a page refresh.
 */
export type ProviderInvite = {
  id: string;
  state: ProviderInviteState;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdBy: { id: string; name: string | null } | null;
};

export type ProviderInviteList = {
  categoryId: string;
  activeCount: number;
  invites: ProviderInvite[];
};

/** The one shape that carries a link. Held in memory, never re-fetched. */
export type IssuedProviderInvite = ProviderInvite & { url: string };

export type ProviderInviteRevokeResult = {
  revoked: boolean;
  invite: ProviderInvite;
};

export type OfferStatus =
  | 'SUBMITTED'
  | 'VIEWED'
  | 'SHORTLISTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'CANCELLED';

export type RefundRecommendedAction = 'FULL_REFUND' | 'NO_REFUND';

/** Where an offer stands under the unviewed-offer refund rule. */
export type UnviewedRefundPolicyStatus =
  | 'AWAITING_VIEW'
  | 'VIEWED'
  | 'ADMIN_DECISION'
  | 'REFUNDED';

export type RefundEligibility = {
  eligible: boolean;
  recommendedAction: RefundRecommendedAction;
  reasonCode: string;
  reasonLabel: string;
  details: string;
  hoursSinceSubmitted: number | null;
  /** False for every offer submitted before the rule shipped. */
  unviewedRefundPolicy: boolean;
  /**
   * The window this offer was sold under and the exact moment its credit
   * becomes refundable — the offer's own snapshot, not the current setting.
   * Null for an offer outside the rule.
   */
  windowHours: number | null;
  eligibleAt: string | null;
  /** `null` for an offer outside the rule — no state to report. */
  policyStatus: UnviewedRefundPolicyStatus | null;
  policyStatusLabel: string | null;
};

export type Offer = {
  id: string;
  offerNumber: string | null;
  requestId: string;
  providerId: string;
  status: OfferStatus;
  priceAmount: number;
  currency: string;
  estimatedStartDate: string | null;
  estimatedCompletionDate: string | null;
  message: string;
  warrantyNote: string | null;
  internalNote: string | null;
  creditCost: number;
  creditSpentTransactionId: string | null;
  creditRefundedTransactionId: string | null;
  creditRefundedAt: string | null;
  creditRefundReason: string | null;
  refundEligibility: RefundEligibility;
  submittedAt: string;
  viewedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
  provider: {
    id: string;
    businessName: string;
    contactName: string;
    phone: string;
    email: string | null;
    city: string;
    district: string;
    status: ProviderStatus;
  };
  request: {
    id: string;
    requestNumber: string | null;
    city: string;
    district: string;
    neighborhood: string | null;
    status: ServiceRequestStatus;
    qualityScore: number;
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    category: {
      id: string;
      name: string;
      slug: string;
    };
    customer: {
      id: string;
      name: string | null;
      email: string | null;
      phone: string | null;
    } | null;
  };
};

export type RefundScanItem = {
  offerId: string;
  providerId: string;
  requestId: string;
  creditCost: number;
  submittedAt: string;
  hoursSinceSubmitted: number | null;
  /** This offer's own window and eligibility moment, not the scan's. */
  windowHours: number | null;
  eligibleAt: string | null;
  reasonCode: 'UNVIEWED_OFFER_48H';
  recommendedAction: 'FULL_REFUND';
};

export type RefundScanSkippedSummary = {
  alreadyRefunded: number;
  viewed: number;
  /** Settled by an administrator's accept or reject on the customer's behalf. */
  adminDecision: number;
  notOldEnough: number;
  noCreditSpend: number;
  /** Offers submitted before the rule shipped. Never refunded. */
  outOfPolicy: number;
  /**
   * In-policy offers carrying no eligibility moment. Should be zero; they are
   * never refunded, so a non-zero count is something to investigate.
   */
  noSchedule: number;
};

export type RefundScanResponse = {
  /**
   * The window a *new* offer is created with, not the one this scan applied:
   * each offer is judged by its own snapshot, which the items report
   * individually.
   */
  currentWindowHours: number;
  eligibleCount: number;
  skippedCount: number;
  items: RefundScanItem[];
  skippedSummary: RefundScanSkippedSummary;
};

export type RefundScanExecuteResult = {
  offerId: string;
  status: 'REFUNDED' | 'SKIPPED' | 'FAILED';
  reason: string;
};

export type RefundScanExecuteResponse = {
  processed: number;
  refunded: number;
  skipped: number;
  results: RefundScanExecuteResult[];
};

export type CreditTransactionType =
  | 'ADMIN_GRANT'
  | 'ADMIN_DEDUCT'
  | 'PACKAGE_PURCHASE'
  | 'OFFER_SPEND'
  | 'OFFER_REFUND'
  | 'ADJUSTMENT'
  | 'CAMPAIGN_GRANT'
  | 'CAMPAIGN_EXPIRE'
  | 'CAMPAIGN_REVOKE';

export type OfferCreditPackage = {
  id: string;
  name: string;
  slug: string;
  creditAmount: number;
  priceAmount: number;
  currency: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type OfferPackageType = 'ONE_TIME_CREDITS' | 'MONTHLY_QUOTA' | 'CATEGORY_UNLIMITED';

export type OfferPackageScopeCategory = {
  category: {
    id: string;
    name: string;
    slug: string;
    kind: 'GROUP' | 'LEAF' | 'ROUTER';
    status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  };
};

/** A package of any type, as the admin screens read it. */
export type AdminOfferPackage = OfferCreditPackage & {
  type: OfferPackageType;
  quotaCredits: number | null;
  periodDays: number | null;
  dailyOfferLimit: number | null;
  scopeCategories: OfferPackageScopeCategory[];
};

/** A category an admin has opened up for unlimited-package scopes. */
export type UnlimitedEligibleCategory = {
  id: string;
  name: string;
  slug: string;
  kind: 'GROUP' | 'LEAF' | 'ROUTER';
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  parentId: string | null;
};

export type ProviderEntitlementStatus = 'ACTIVE' | 'EXPIRED' | 'PAST_DUE' | 'CANCELLED';

export type EntitlementRenewalAttempt = {
  id: string;
  periodIndex: number;
  status: 'SUCCEEDED' | 'FAILED' | 'UNSUPPORTED';
  failureCode: string | null;
  paymentProvider: string | null;
  /**
   * The payment provider's own opaque transaction identifier — the reference an
   * operator uses to find the transaction on the provider's side. Never a
   * payload, never a card detail, never a stored credential.
   */
  providerTransactionRef: string | null;
  attemptedAt: string;
};

export type AdminProviderEntitlement = {
  id: string;
  packageId: string;
  type: OfferPackageType;
  packageName: string;
  priceAmount: number;
  currency: string;
  startAt: string;
  endAt: string;
  periodDays: number;
  status: ProviderEntitlementStatus;
  usable: boolean;
  queued: boolean;
  quotaTotal: number | null;
  quotaRemaining: number | null;
  dailyOfferLimit: number | null;
  scope: { categoryId: string; name: string; kind: string }[];
  autoRenewEnabled: boolean;
  cancelledAt: string | null;
  lastRenewalAttemptAt: string | null;
  lastRenewalFailureCode: string | null;
  periodIndex: number;
  purchaseId: string | null;
  purchaseNumber: string | null;
  paymentProvider: string | null;
  /** Whether a stored payment method exists. The reference itself never travels. */
  paymentMethodOnFile: boolean;
  renewalAttempts: EntitlementRenewalAttempt[];
};

export type AdminProviderEntitlements = {
  providerId: string;
  autoRenew: {
    available: boolean;
    unsupportedReason: string | null;
    message: string | null;
    periodDays: number;
  };
  entitlements: AdminProviderEntitlement[];
};

export type ProviderCreditTransaction = {
  id: string;
  providerId: string;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
  createdBy?: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

export type ProviderCredits = {
  providerId: string;
  balance: number;
  transactions: ProviderCreditTransaction[];
};

/**
 * `GET /admin/providers/:id/credits`, the staff read on FINANCE_LEDGER_READ
 * (ADMIN-DESIGN-000). The same shape as the provider's own read, plus the
 * provider's label so the screen needs no second permission to name itself.
 */
export type AdminProviderCredits = ProviderCredits & {
  provider: {
    id: string;
    businessName: string;
    status: ProviderProfile['status'];
    city: string;
    district: string;
  };
};

export type PackagePurchaseStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';

/**
 * Which payment adapter the API is wired to.
 *
 * `mock` is the in-app test checkout; `lemon-squeezy-test` is a Lemon Squeezy
 * **sandbox** integration. Neither collects real money. Live payment collection
 * is not part of this build and is blocked at boot — see the payments section
 * of the README for the approval this is waiting on.
 */
export type PaymentProviderKind = 'mock' | 'lemon-squeezy-test';

export type AdminPaymentConfig = {
  provider: PaymentProviderKind;
  mode: 'test';
  liveEnabled: false;
  configurableKeys: string[];
  /**
   * Names of settings that are missing or malformed. The API never returns
   * their values, and this screen never asks for them.
   */
  missingConfig: string[];
  ready: boolean;
};

export type PackagePurchase = {
  id: string;
  purchaseNumber: string | null;
  providerId: string;
  packageId: string;
  status: PackagePurchaseStatus;
  creditAmountSnapshot: number;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  packageNameSnapshot: string;
  providerNote: string | null;
  adminNote: string | null;
  mockPaymentReference: string | null;
  mockPaymentFailureReason: string | null;
  paymentProvider: PaymentProviderKind | null;
  providerCheckoutId: string | null;
  providerCheckoutExpiresAt: string | null;
  providerOrderId: string | null;
  paymentFailureCode: string | null;
  manualReviewReason: string | null;
  manualReviewAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  refundedAt: string | null;
  creditTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
  provider: {
    id: string;
    businessName: string;
    contactName: string;
    email: string | null;
    city: string;
    district: string;
    status: ProviderStatus;
  };
  package: {
    id: string;
    name: string;
    slug?: string;
    creditAmount: number;
    priceAmount: number;
    currency: string;
    isActive: boolean;
  };
  /**
   * What the payment provider's settlement notices did to this purchase. Only
   * present on the detail endpoint.
   *
   * Short machine codes and timestamps. There is no payload, signature,
   * correlation token or buyer detail on this projection, and no endpoint that
   * could add one.
   */
  webhookEvents?: PaymentWebhookAttempt[];
};

export type PaymentWebhookAttempt = {
  eventName: string;
  status: 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'MISMATCHED' | 'MANUAL_REVIEW_REQUIRED';
  detail: string | null;
  /** How many deliveries of this one event were handled. */
  attemptCount: number;
  /** The first refusal, kept even after a later delivery settled the event. */
  firstFailureCode: string | null;
  firstFailureAt: string | null;
  lastAttemptAt: string;
  resolvedAt: string | null;
  createdAt: string;
};

export const CUSTOMER_SORT_FIELDS = [
  'name',
  'createdAt',
  'lastRequestAt',
  'requestCount',
  'offerCount',
  'acceptedOfferCount',
] as const;

export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

export type CustomerSortDirection = 'asc' | 'desc';

export const CUSTOMER_ORIGIN_VALUES = [
  'REGISTERED',
  'AUTO_CREATED_REQUEST',
  'ADMIN_CREATED',
  'IMPORTED',
] as const;

export type CustomerOrigin = (typeof CUSTOMER_ORIGIN_VALUES)[number];

export type CustomerSummary = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  customerOrigin: CustomerOrigin | null;
  /**
   * The account's own proofs — `User.emailVerifiedAt` / `User.phoneVerifiedAt`
   * — and the only source of a verification badge. Optional so an older API
   * answer reads as "not proven" rather than failing.
   */
  emailVerifiedAt?: string | null;
  phoneVerifiedAt?: string | null;
  requestCount: number;
  offerCount: number;
  acceptedOfferCount: number;
  lastRequestAt: string | null;
  lastRequestCity: string | null;
};

export type CustomerListMeta = {
  anonymousRequestCount: number;
};

export type CustomerListResponse = {
  items: CustomerSummary[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  meta: CustomerListMeta;
};

export type CustomerDetail = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  customerOrigin: CustomerOrigin | null;
  hasPassword: boolean;
  /** The same two account columns the list carries; see CustomerSummary. */
  emailVerifiedAt?: string | null;
  phoneVerifiedAt?: string | null;
};

export type CustomerMetrics = {
  requestCount: number;
  offerCount: number;
  acceptedOfferCount: number;
  lastRequestAt: string | null;
};

export type CustomerRecentRequest = {
  id: string;
  requestNumber: string | null;
  categoryName: string;
  city: string;
  district: string;
  status: ServiceRequestStatus;
  qualityLabel: QualityLabel;
  submittedAt: string;
  offerCount: number;
};

export type CustomerRecentOffer = {
  id: string;
  offerNumber: string | null;
  requestId: string;
  requestNumber: string | null;
  providerId: string;
  providerName: string;
  priceAmount: number;
  currency: string;
  status: OfferStatus;
  submittedAt: string;
};

export type CustomerDetailResponse = {
  customer: CustomerDetail;
  metrics: CustomerMetrics;
  recentRequests: CustomerRecentRequest[];
  recentOffers: CustomerRecentOffer[];
  acceptedOffers: CustomerRecentOffer[];
};

export type CustomerNote = {
  id: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  createdBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

export type CustomerNotesResponse = {
  items: CustomerNote[];
};

export type CreateCustomerNoteInput = {
  note: string;
};

export type UpdateCustomerStatusInput = {
  isActive: boolean;
};

export type UpdateCustomerStatusResponse = {
  id: string;
  isActive: boolean;
};

export type CustomerActivationLinkResponse = {
  activationUrl: string;
  expiresAt: string;
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    customerOrigin: CustomerOrigin | null;
  };
};

export type AuthUser = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: UserRole;
  isActive: boolean;
};

/**
 * ADMIN joined the set in PR-0. It is an account kind and not a capability:
 * what an ADMIN may do comes entirely from `AdminSession.permissions`, and an
 * ADMIN with none cannot open the panel at all.
 */
export type UserRole = 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER' | 'ADMIN';

export const USER_ROLE_VALUES = ['SUPER_ADMIN', 'CUSTOMER', 'PROVIDER', 'ADMIN'] as const;

export const USER_SORT_FIELDS = [
  'name',
  'email',
  'role',
  'createdAt',
  'lastLoginAt',
  'isActive',
] as const;

export type AdminUserSortField = (typeof USER_SORT_FIELDS)[number];

export const USER_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type AdminUserSortDirection = (typeof USER_SORT_DIRECTIONS)[number];

export type AdminUserSummary = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  hasPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
};

export type AdminUsersResponse = {
  items: AdminUserSummary[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export type AdminUserDetail = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  hasPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminUserMetrics = {
  activeSessionCount: number;
};

export type AdminUserDetailResponse = {
  user: AdminUserDetail;
  metrics: AdminUserMetrics;
};

export type UpdateUserStatusInput = {
  isActive: boolean;
};

export type UpdateUserStatusResponse = {
  id: string;
  isActive: boolean;
};

export type CreateAdminUserInput = {
  name: string;
  email: string;
  phone?: string;
};

export type CreateAdminUserResponse = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    role: UserRole;
    isActive: boolean;
    hasPassword: boolean;
    createdAt: string;
  };
  inviteUrl: string;
  expiresAt: string;
};

export type AdminInviteLinkResponse = {
  inviteUrl: string;
  expiresAt: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    role: UserRole;
  };
};

export type AdminInviteValidateResponse = {
  valid: true;
  user: {
    name: string | null;
    email: string | null;
  };
  expiresAt: string;
};

export function userRoleLabel(role: UserRole): string {
  const labels: Record<UserRole, string> = {
    SUPER_ADMIN: 'Süper Admin',
    // A staff account whose authority is entirely its assigned roles. Named
    // "Yönetici" rather than after any one role, because the roles are the
    // operator's to define and this label must not imply a fixed set.
    ADMIN: 'Yönetici',
    CUSTOMER: 'Müşteri',
    PROVIDER: 'Hizmet Veren',
  };
  return labels[role] ?? role;
}

export function userRoleBadgeClass(role: UserRole): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'badge badge-warn';
    // Deliberately quieter than SUPER_ADMIN's: a staff account with assigned
    // roles is the ordinary case, and the warning colour should keep meaning
    // "this one holds everything".
    case 'ADMIN':
      return 'badge badge-info';
    case 'PROVIDER':
      return 'badge badge-good';
    case 'CUSTOMER':
      return 'badge';
    default:
      return 'badge badge-muted';
  }
}

export type AdminSummary = {
  totalRequests: number;
  pendingRequests: number;
  inReviewRequests: number;
  approvedProviders: number;
  pendingProviders: number;
  totalOffers: number;
  refundableOffers: number;
  packagePurchases: number;
  /** OPEN + IN_PROGRESS tickets — the support backlog, never RESOLVED or CLOSED. */
  openSupportTickets: number;
  /** Requests with at least one undecided provider report — the report queue. */
  openRequestReports: number;
};

export type FinanceSummaryRecentTransaction = {
  id: string;
  providerId: string;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  sourceNumber: string | null;
  createdAt: string;
  provider: {
    id: string;
    businessName: string;
  };
  createdBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

/** Mirrors the API's allowlist select for the finance summary; nothing more. */
export type FinanceSummaryRecentPurchase = {
  id: string;
  purchaseNumber: string | null;
  providerId: string;
  status: PackagePurchaseStatus;
  creditAmountSnapshot: number;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  packageNameSnapshot: string;
  mockPaymentReference: string | null;
  createdAt: string;
  provider: {
    businessName: string;
  };
};

export const CREDIT_TRANSACTION_TYPES: CreditTransactionType[] = [
  'PACKAGE_PURCHASE',
  'OFFER_SPEND',
  'OFFER_REFUND',
  'ADMIN_GRANT',
  'ADMIN_DEDUCT',
  'ADJUSTMENT',
  'CAMPAIGN_GRANT',
  'CAMPAIGN_EXPIRE',
  'CAMPAIGN_REVOKE',
];

export type CreditLedgerProvider = {
  id: string;
  businessName: string;
  phone: string;
  email: string | null;
};

export type CreditLedgerEntry = {
  id: string;
  createdAt: string;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  previousBalance: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  sourceNumber: string | null;
  /** The campaign behind a CAMPAIGN_* row (CMP-004 S4); null on every other row. */
  campaign: { id: string; name: string; versionNumber: number } | null;
  provider: CreditLedgerProvider;
  createdBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

export type CreditLedgerResponse = {
  items: CreditLedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

/**
 * The audit row that records a contact reveal, plus the details themselves when
 * the feature is on and a reveal really happened.
 *
 * The event names ids and a timestamp — no person — so it stays visible to an
 * operator regardless of the flag. `contacts` is null whenever the feature is
 * off, no reveal exists, or the reveal does not agree with matchedOfferId.
 */
export type ContactRevealEvent = {
  requestId: string;
  offerId: string;
  providerId: string;
  customerUserId: string | null;
  revealedAt: string;
  disclosureVersion: string;
};

export type ContactRevealDetail = {
  enabled: boolean;
  event: ContactRevealEvent | null;
  contacts: {
    provider: {
      id: string;
      businessName: string;
      contactName: string;
      phone: string;
      email: string | null;
      city: string;
      district: string;
    };
    customer: {
      customerName: string;
      customerPhone: string;
      customerEmail: string | null;
    };
  } | null;
};

export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Mirrors NOTIFICATION_ERROR_CODES on the API side. */
export const NOTIFICATION_ERROR_CODES = [
  'TRANSPORT_UNAVAILABLE',
  'REJECTED',
  'TIMEOUT',
  'INVALID_RECIPIENT',
  // Composed but deliberately not sent: the company footer is unfinished, or
  // this deployment's public base URL cannot be opened by a recipient.
  'EMAIL_BRANDING_INCOMPLETE',
  'EMAIL_PUBLIC_URL_INVALID',
  // A retry could not rebuild the message from live data.
  'SOURCE_UNAVAILABLE',
  'UNKNOWN',
] as const;
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

/** The templates this build sends; the filter still accepts any stored value. */
export const NOTIFICATION_TEMPLATES = [
  'customer-activation',
  'request-expiring',
  'phone-verification-code',
  'provider-claim',
  'password-reset',
  'email-verification',
  'provider-application-received',
  'provider-application-approved',
  'request-received',
  'request-published',
  'offer-received',
  'match-customer',
  'request-available',
  'offer-accepted',
  'offer-not-selected',
  'credit-refunded',
  'support-ticket-created',
  'support-ticket-new-for-support',
  'support-ticket-customer-reply',
  'support-ticket-admin-reply',
  'support-ticket-status-changed',
] as const;

/**
 * The whole notification payload an operator may see.
 *
 * There is no body, subject, action URL, one-time code or raw recipient field
 * here, and there is none on the API side either — NotificationLog never stored
 * any of them. `errorLabel` is the API's own safe wording for `errorCode`; the
 * raw transport error never leaves the API process.
 */
export type NotificationLogEntry = {
  id: string;
  channel: NotificationChannel;
  template: string;
  maskedRecipient: string;
  status: NotificationStatus;
  errorCode: NotificationErrorCode | null;
  errorLabel: string | null;
  providerMessageId: string | null;
  providerMessageIdRedacted: boolean;
  requestId: string | null;
  userId: string | null;
  /** The provider application a message was about. An id only — never a join. */
  providerId: string | null;
  /** Attempts against this one message: the first send plus every retry. */
  attemptCount: number;
  /** When the latest attempt was claimed, including one still in flight. */
  lastAttemptAt: string | null;
  createdAt: string;
  sentAt: string | null;
  failedAt: string | null;
  /**
   * Whether this row may be re-sent. Computed by the API from the row itself —
   * the screen never decides it, and the retry endpoint checks it again.
   */
  retryable: boolean;
  retryBlock: NotificationRetryBlock | null;
  /** The reason as a sentence, so the screen does not restate the rules. */
  retryBlockLabel: string | null;
};

export type NotificationRetryBlock =
  | 'CHANNEL_NOT_EMAIL'
  | 'STATUS_NOT_FAILED'
  | 'TEMPLATE_NOT_REPRODUCIBLE'
  | 'NO_SOURCE_TRANSITION';

export type NotificationLogResponse = {
  items: NotificationLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export function notificationChannelLabel(channel: NotificationChannel | string): string {
  const labels: Record<string, string> = {
    EMAIL: 'E-posta',
    SMS: 'SMS',
  };

  return labels[channel] ?? channel;
}

/**
 * What each audit status actually means, in the words an operator can act on.
 *
 * SENT is deliberately *not* "Gönderildi". The dispatcher writes it the moment
 * the transport accepts the request — for Resend, an HTTP 2xx on POST /emails —
 * and acceptance is not delivery. A message can be accepted and then bounce, be
 * suppressed, or sit in a delayed queue, and this platform stores no delivery
 * callback, so nothing in this table can ever say a message arrived. Reading
 * SENT as "delivered" is what turned a bounced provider invitation into a
 * successful-looking row, so the label now says exactly what the row knows.
 */
export function notificationStatusLabel(status: NotificationStatus | string): string {
  const labels: Record<string, string> = {
    PENDING: 'Sırada',
    SENT: 'Gönderim sağlayıcısına iletildi',
    FAILED: 'Başarısız',
  };

  return labels[status] ?? status;
}

/**
 * The one-line explanation the detail screen prints under the status, so the
 * distinction above survives outside this file.
 */
export function notificationStatusMeaning(status: NotificationStatus | string): string | null {
  switch (status) {
    case 'SENT':
      return 'Sağlayıcı gönderim isteğini kabul etti. Bu, alıcının kutusuna ulaştığı anlamına gelmez; teslim, sıçrama (bounce) ve şikâyet bilgisi bu kayıtta tutulmaz.';
    case 'PENDING':
      return 'Gönderim başlatıldı ve sonucu henüz kaydedilmedi.';
    case 'FAILED':
      return 'Sağlayıcı gönderimi kabul etmedi veya mesaj gönderilmeden önce reddedildi.';
    default:
      return null;
  }
}

export function notificationStatusBadgeClass(status: NotificationStatus | string): string {
  switch (status) {
    case 'SENT':
      return 'badge badge-good';
    case 'PENDING':
      return 'badge badge-warn';
    case 'FAILED':
      return 'badge badge-bad';
    default:
      return 'badge badge-muted';
  }
}

/**
 * A template name is a code-controlled literal, so an unrecognised one is shown
 * as-is rather than hidden — that is what keeps a row from an older build
 * readable instead of blank.
 */
export function notificationTemplateLabel(template: string): string {
  const labels: Record<string, string> = {
    'customer-activation': 'Hesap etkinleştirme',
    'request-expiring': 'Talep süresi uyarısı',
    'phone-verification-code': 'Telefon doğrulama kodu',
    'provider-claim': 'Başvuru sahiplenme daveti',
    'password-reset': 'Şifre sıfırlama',
    'email-verification': 'E-posta doğrulama',
    'provider-application-received': 'Başvuru alındı',
    'provider-application-approved': 'Başvuru onaylandı',
    'request-received': 'Talep alındı',
    'request-published': 'Talep yayında',
    'offer-received': 'Yeni teklif',
    'match-customer': 'Eşleşme (müşteri)',
    'request-available': 'Bölgede yeni talep',
    'offer-accepted': 'Teklif kabul edildi',
    'offer-not-selected': 'Teklif seçilmedi',
    'credit-refunded': 'Kredi iadesi',
    // The two that go to the support mailbox are named for the mailbox, so a
    // row addressed to the company is not read as one addressed to a customer.
    'support-ticket-created': 'Destek talebi alındı',
    'support-ticket-new-for-support': 'Destek: yeni talep',
    'support-ticket-customer-reply': 'Destek: müşteri yanıtı',
    'support-ticket-admin-reply': 'Destek talebine yanıt',
    'support-ticket-status-changed': 'Destek talebi durumu',
    'support-ticket-provider-created': 'Destek talebi alındı (hizmet veren)',
    'support-ticket-provider-new-for-support': 'Destek: yeni talep (hizmet veren)',
    'support-ticket-provider-reply': 'Destek: hizmet veren yanıtı',
    'support-ticket-provider-admin-reply': 'Destek talebine yanıt (hizmet veren)',
    'support-ticket-provider-status-changed': 'Destek talebi durumu (hizmet veren)',
    'package-purchase-confirmation': 'Kredi paketi makbuzu',
    'request-expired-customer': 'Talep süresi doldu (müşteri)',
    'request-expired-provider': 'Talep süresi doldu (hizmet veren)',
    // Vitrin: the run's life, from the money to the end of the clock.
    'showcase-placement-activated': 'Vitrin: kart yayında',
    'showcase-lead-received': 'Vitrin: yeni talep',
    'showcase-lead-breached-customer': 'Vitrin: yanıt süresi doldu (müşteri)',
    'showcase-lead-breached-provider': 'Vitrin: yanıt süresi doldu (hizmet veren)',
    'showcase-package-payment-succeeded': 'Vitrin: paket ödemesi alındı',
    'showcase-package-payment-failed': 'Vitrin: paket ödemesi tamamlanmadı',
    'showcase-card-approved-live': 'Vitrin: kart onaylandı ve yayında',
    'showcase-card-approved': 'Vitrin: kart onaylandı',
    'showcase-placement-ending-7d': 'Vitrin: yayına 7 gün kaldı',
    'showcase-placement-ending-3d': 'Vitrin: yayına 3 gün kaldı',
    'showcase-placement-expired': 'Vitrin: yayın sona erdi',
    // Provider reviews: the invitation, the provider's copy, the support
    // notice for a report, and the customer's removal notice.
    'review-invitation': 'Değerlendirme daveti',
    'review-received': 'Yeni değerlendirme',
    'review-report-new-for-support': 'Değerlendirme bildirimi (destek)',
    'review-removed': 'Değerlendirme kaldırıldı',
    'package-refund-status': 'Paket iade talebi durumu',
  };

  return labels[template] ?? template;
}

export const PROVIDER_FINANCE_SORT_FIELDS = [
  'businessName',
  'currentBalance',
  'totalPaidAmount',
  'totalCreditsPurchased',
  'totalCreditsSpent',
  'totalCreditsRefunded',
  'manualNetCredits',
  'lastPaymentAt',
  'lastTransactionAt',
] as const;

export type ProviderFinanceSortField = (typeof PROVIDER_FINANCE_SORT_FIELDS)[number];

export type ProviderFinanceSortDirection = 'asc' | 'desc';

export type ProviderFinanceItem = {
  provider: {
    id: string;
    businessName: string;
    phone: string;
    email: string | null;
    status: ProviderStatus;
  };
  currentBalance: number;
  totalPaidAmount: number;
  totalCreditsPurchased: number;
  totalCreditsSpent: number;
  totalCreditsRefunded: number;
  totalCreditsAdminGranted: number;
  totalCreditsAdminDeducted: number;
  manualNetCredits: number;
  totalCreditsAdjusted: number;
  lastPaymentAt: string | null;
  lastTransactionAt: string | null;
};

export type ProviderFinanceResponse = {
  items: ProviderFinanceItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export type FinanceAnalyticsGroupBy = 'day' | 'month' | 'year';

export type FinanceAnalyticsBucket = {
  key: string;
  label: string;
  start: string;
  end: string;
  paidRevenue: number;
  paidPackageCount: number;
  soldCredits: number;
  spentCredits: number;
  refundedCredits: number;
  adminGrantedCredits: number;
  adminDeductedCredits: number;
};

export type FinanceAnalyticsTotals = {
  paidRevenue: number;
  paidPackageCount: number;
  soldCredits: number;
  spentCredits: number;
  refundedCredits: number;
  adminGrantedCredits: number;
  adminDeductedCredits: number;
};

export type FinanceAnalyticsResponse = {
  range: {
    from: string;
    to: string;
    groupBy: FinanceAnalyticsGroupBy;
  };
  totals: FinanceAnalyticsTotals;
  buckets: FinanceAnalyticsBucket[];
};

export type FinanceSummary = {
  revenue: {
    totalRevenuePaid: number;
    todayRevenuePaid: number;
    monthRevenuePaid: number;
  };
  packagePurchases: {
    totalPackagePurchases: number;
    paidPackagePurchases: number;
    pendingPackagePurchases: number;
    cancelledPackagePurchases: number;
    failedPackagePurchases: number;
    expiredPackagePurchases: number;
    refundedPackagePurchases: number;
  };
  credits: {
    totalCreditsSold: number;
    totalCreditsSpent: number;
    totalCreditsRefunded: number;
    totalCreditsAdminGranted: number;
    totalCreditsAdminDeducted: number;
    totalCreditsAdjusted: number;
    totalActiveProviderCreditBalance: number;
  };
  recentTransactions: FinanceSummaryRecentTransaction[];
  recentPurchases: FinanceSummaryRecentPurchase[];
};

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    SUBMITTED: 'Gönderildi',
    IN_REVIEW: 'İncelemede',
    APPROVED: 'Onaylandı',
    REJECTED: 'Reddedildi',
    CANCELLED: 'İptal',
    VIEWED: 'Görüntülendi',
    SHORTLISTED: 'Kısa listede',
    ACCEPTED: 'Kabul edildi',
    WITHDRAWN: 'Geri çekildi',
    EXPIRED: 'Süresi doldu',
    PENDING_REVIEW: 'İnceleme bekliyor',
    PENDING: 'Bekliyor',
    PAID: 'Ödendi',
    FAILED: 'Başarısız',
    SUSPENDED: 'Askıya alındı',
    REFUNDED: 'İade edildi',
    DRAFT: 'Taslak',
  };

  return labels[status] ?? status;
}

export function requestStatusLabel(status: string) {
  const labels: Record<string, string> = {
    DRAFT: 'Taslak',
    SUBMITTED: 'Yeni Talep',
    IN_REVIEW: 'İncelemede',
    APPROVED: 'Onaylandı',
    MATCHED: 'Eşleşti',
    COMPLETED: 'Tamamlandı',
    REJECTED: 'Reddedildi',
    CANCELLED: 'İptal Edildi',
    EXPIRED: 'Süresi Doldu',
  };

  return labels[status] ?? statusLabel(status);
}

export function qualityLabel(label: string) {
  const labels: Record<string, string> = {
    HIGH: 'Yüksek',
    MEDIUM: 'Orta',
    LOW: 'Düşük',
  };

  return labels[label] ?? label;
}

export function qualityBadgeClass(label: string) {
  switch (label) {
    case 'HIGH':
      return 'badge badge-good';
    case 'MEDIUM':
      return 'badge badge-warn';
    case 'LOW':
      return 'badge badge-bad';
    default:
      return 'badge';
  }
}

export function statusBadgeClass(status: string) {
  switch (status) {
    case 'APPROVED':
    case 'ACCEPTED':
    case 'MATCHED':
    case 'COMPLETED':
    case 'PAID':
      return 'badge badge-good';
    case 'PENDING':
    case 'PENDING_REVIEW':
    case 'IN_REVIEW':
    case 'SUBMITTED':
    case 'VIEWED':
    case 'SHORTLISTED':
    case 'DRAFT':
      return 'badge badge-warn';
    case 'REJECTED':
    case 'FAILED':
    case 'CANCELLED':
    case 'SUSPENDED':
    case 'EXPIRED':
    case 'WITHDRAWN':
    case 'REFUNDED':
      return 'badge badge-bad';
    default:
      return 'badge';
  }
}

export function refundActionLabel(action: string) {
  const labels: Record<string, string> = {
    FULL_REFUND: 'İade edilecek',
    NO_REFUND: 'İade yok',
  };

  return labels[action] ?? action;
}

export function refundActionBadgeClass(action: string) {
  switch (action) {
    case 'FULL_REFUND':
      return 'badge badge-good';
    case 'NO_REFUND':
      return 'badge badge-muted';
    default:
      return 'badge';
  }
}

export function customerOriginLabel(origin: CustomerOrigin | null | undefined): string {
  if (!origin) return 'Bilinmiyor';
  const labels: Record<CustomerOrigin, string> = {
    REGISTERED: 'Normal kayıt',
    AUTO_CREATED_REQUEST: 'Otomatik oluşturulan müşteri',
    ADMIN_CREATED: 'Admin oluşturdu',
    IMPORTED: 'İçe aktarıldı',
  };
  return labels[origin];
}

export function customerOriginBadgeClass(origin: CustomerOrigin | null | undefined): string {
  switch (origin) {
    case 'REGISTERED':
      return 'badge badge-good';
    case 'AUTO_CREATED_REQUEST':
      return 'badge badge-warn';
    case 'ADMIN_CREATED':
      return 'badge';
    case 'IMPORTED':
      return 'badge badge-muted';
    default:
      return 'badge badge-muted';
  }
}

export function qualityBreakdownLabel(key: string) {
  const labels: Record<string, string> = {
    phonePresent: 'Telefon bilgisi',
    namePresent: 'Müşteri adı',
    cityDistrictPresent: 'İl / ilçe',
    locationDetailPresent: 'Konum detayı',
    budgetPresent: 'Bütçe',
    preferredDatePresent: 'Tercih tarihi',
    urgencyPresent: 'Aciliyet',
    descriptionDetailed: 'Açıklama detayı',
    requiredAnswersComplete: 'Zorunlu yanıtlar',
    optionalAnswersCompleted: 'Opsiyonel yanıtlar',
  };

  if (labels[key]) return labels[key];

  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return spaced.charAt(0).toLocaleUpperCase('tr-TR') + spaced.slice(1);
}

// `min` and `max` are stored as minor-unit integers (kuruş for TRY). `formatPrice`
// converts them to the human readable amount with two fractional digits.
export function formatBudgetRange(min: number | null, max: number | null, currency: string = 'TRY') {
  if (min === null && max === null) {
    return 'Belirtilmedi';
  }

  if (min !== null && max !== null) {
    if (min === max) {
      return formatPrice(min, currency);
    }
    return `${formatPrice(min, currency)} – ${formatPrice(max, currency)}`;
  }

  if (min !== null) {
    return `≥ ${formatPrice(min, currency)}`;
  }

  return `≤ ${formatPrice(max as number, currency)}`;
}

/**
 * The stored urgency code in the words an operator reads.
 *
 * Same shared table as the web app and the API's e-mail templates — see
 * @taktic/shared/urgency for why there is only one. `-` for anything it does
 * not know, never the raw code.
 */
export function urgencyLabel(urgency: string | null) {
  return sharedUrgencyLabel(urgency) ?? '-';
}

export function creditTxnTypeLabel(type: string) {
  const labels: Record<string, string> = {
    ADMIN_GRANT: 'Yönetici eklemesi',
    ADMIN_DEDUCT: 'Yönetici düşüşü',
    PACKAGE_PURCHASE: 'Paket alımı',
    OFFER_SPEND: 'Teklif harcaması',
    OFFER_REFUND: 'Teklif iadesi',
    ADJUSTMENT: 'Düzeltme',
    CAMPAIGN_GRANT: 'Promosyon kredisi',
    CAMPAIGN_EXPIRE: 'Promosyon süresi doldu',
    CAMPAIGN_REVOKE: 'Promosyon geri alındı',
  };

  return labels[type] ?? type;
}

// `amountMinor` is the monetary value in the currency's minor unit (e.g. kuruş for TRY,
// cents for USD/EUR). The function converts it back to a human-readable string with
// two fractional digits, matching the storage contract used across the platform.
// Example: formatPrice(49900, 'TRY') -> "₺499,00"
export function formatPrice(amountMinor: number, currency: string = 'TRY') {
  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

// Form-side money parsing and formatting live in @taktic/shared (`money.ts`):
// `parseTurkishLiraToMinor` and `formatMinorAsTurkishLiraInput`. One parser for
// every admin form that takes a lira amount, and no floating point in any of
// them.

/**
 * Re-exported from @taktic/shared rather than reimplemented.
 *
 * These used to call `toLocaleDateString('tr-TR', …)` with no `timeZone`, which
 * means "whatever zone this process is in". The server renders in the
 * container's UTC and the browser re-renders in the visitor's UTC+3, so the two
 * produced different text for the same instant and React tore the tree down on
 * hydration. The shared implementation pins both the zone and the locale, so
 * SSR and the first client render agree by construction.
 */
export { formatDate, formatDateRange, formatDateTime, formatTime } from '@taktic/shared';

/**
 * Carries the HTTP status so callers can map an upstream 404 onto Next's
 * notFound() instead of letting it bubble up as a generic 500.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(body || `API request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

/** The short machine code on an API refusal, when there is one. */
function readErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    /*
     * Three refusals, two destinations (PR-0).
     *
     * 401 — no usable session — is the sign-in form's, as it always was. A 403
     * splits in two, and the API says which (`admin-access.guard.ts`):
     *
     *   NOT_STAFF  a customer's or a provider's session asking for an admin
     *              screen. They are signed in as the wrong kind of account, so
     *              the sign-in form is still the right answer — and this is the
     *              behaviour that existed before permissions did.
     *   otherwise  a staff account missing a role or a permission. Sending that
     *              to the sign-in form is a loop: they are already past it,
     *              signing in again changes nothing, and nothing explains why.
     *
     * A 403 with no readable code falls to `/yetkisiz`, which is the safer of
     * the two: it explains rather than asking for credentials the caller
     * already presented.
     */
    if (response.status === 401) {
      redirect('/login');
    }

    if (response.status === 403) {
      redirect(readErrorCode(await response.text()) === 'NOT_STAFF' ? '/login' : '/yetkisiz');
    }

    throw new ApiError(response.status, await response.text());
  }

  return response.json() as Promise<T>;
}

/**
 * Runs a fetch and turns an upstream "not found" into a proper 404 page.
 * Used by detail screens so a bad id (or a path like /providers/new that falls
 * through to the dynamic [id] route) never renders a server-error screen.
 */
export async function fetchOrNotFound<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      notFound();
    }

    throw error;
  }
}

/** Every capability the API may ask of a staff account (PR-0 catalogue). */
export type AdminPermission = string;

export type AdminSession = {
  user: AuthUser;
  isSuperAdmin: boolean;
  permissions: AdminPermission[];
  /** The same question the API's PermissionsGuard asks, asked from a screen. */
  can: (...required: AdminPermission[]) => boolean;
};

/**
 * Who is looking at this screen, and what they may do — from the API, never
 * from a guess about their role.
 *
 * `GET /admin/me/permissions` is the single source (design D13): the route
 * guard, this call, the sidebar and every button answer from the same response,
 * so a hidden control and a refused request are two views of one fact.
 *
 * Two different refusals, deliberately:
 *
 *   not staff at all  → /login, because there is nothing here for them and the
 *                       likely truth is that they are signed in as somebody else.
 *   staff, wrong      → /yetkisiz, because bouncing them to a login form they
 *   permission          are already past is a loop, not an explanation.
 *
 * Pass the permission a page needs and it is checked before anything renders;
 * pass nothing and the page only requires panel access.
 */
/**
 * The session's capabilities, or null — never a redirect.
 *
 * The root layout renders on every page including `/login`, where there is no
 * session at all, so it cannot use `requireAdmin`: a redirect to `/login` from
 * the layout of `/login` is an infinite loop. This asks the same question and
 * answers "nobody" instead of navigating, which is exactly what a sidebar needs
 * — it has nothing to show a signed-out visitor and nothing to say about it.
 *
 * It deliberately swallows every failure. A sidebar that throws takes the whole
 * panel down over a transport hiccup; a sidebar that renders empty is a bad
 * minute, and the page itself still gates on `requireAdmin`.
 */
export async function readAdminAccess(): Promise<{
  isSuperAdmin: boolean;
  permissions: AdminPermission[];
} | null> {
  try {
    const cookieHeader = (await cookies()).toString();
    if (!cookieHeader) {
      return null;
    }

    const response = await fetch(`${apiUrl}/admin/me/permissions`, {
      cache: 'no-store',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { isSuperAdmin: boolean; permissions: AdminPermission[] };
    return { isSuperAdmin: body.isSuperAdmin === true, permissions: body.permissions ?? [] };
  } catch {
    return null;
  }
}

/**
 * The operator's catalogue for a *filter* — draft categories included, and an
 * empty list rather than a refusal when this session may not see them.
 *
 * Several screens that have nothing to do with the catalogue still need its
 * names: the offers, requests and providers lists label and filter by category,
 * and a provider's bindings may point at a category the marketplace has not
 * released. Requiring `CATALOG_READ` for those screens would say "you cannot
 * look at offers unless you may see next quarter's catalogue", which is the
 * wrong coupling — so a session without it gets a shorter dropdown and the page
 * it actually came for.
 *
 * A raw fetch rather than `apiFetch`, deliberately: `apiFetch` turns a 403 into
 * a redirect, and catching a redirect to ignore it is how a real refusal
 * elsewhere gets swallowed by accident. This asks the question and answers it.
 */
export async function listCatalogueForFilter(): Promise<Category[]> {
  try {
    const cookieHeader = (await cookies()).toString();
    const response = await fetch(`${apiUrl}/admin/categories`, {
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    });

    if (!response.ok) {
      return [];
    }

    return (await response.json()) as Category[];
  } catch {
    return [];
  }
}

export async function requireAdmin(...required: AdminPermission[]): Promise<AdminSession> {
  const [user, access] = await Promise.all([
    apiFetch<AuthUser>('/auth/me'),
    // A 403 here means "not staff, or staff with no live role": apiFetch sends
    // those to /login, which is the right destination for both.
    apiFetch<{ role: UserRole; isSuperAdmin: boolean; permissions: AdminPermission[] }>(
      '/admin/me/permissions',
    ),
  ]);

  const held = new Set(access.permissions);
  const can = (...names: AdminPermission[]) =>
    access.isSuperAdmin || names.every((name) => held.has(name));

  if (required.length > 0 && !can(...required)) {
    redirect('/yetkisiz');
  }

  return { user, isSuperAdmin: access.isSuperAdmin, permissions: access.permissions, can };
}

/**
 * Admits a SUPER_ADMIN and sends every other staff account to /yetkisiz.
 *
 * For the root screens (roles, creating staff accounts): their capabilities
 * are not `AdminPermission` values, so `requireAdmin(permission)` cannot
 * express them (RG-7 §12.1). The API refuses the same calls with
 * `@Roles(SUPER_ADMIN)`; this makes the screen say so before it renders
 * instead of after its first request.
 */
export async function requireSuperAdmin(): Promise<AdminSession> {
  const session = await requireAdmin();
  if (!session.isSuperAdmin) {
    redirect('/yetkisiz');
  }
  return session;
}

/** One recorded change to an operations setting. */
export type OperationsSettingsChange = {
  id: string;
  setting: string;
  /** Null on the first save, when the effective value was the product default. */
  previousValue: string | null;
  newValue: string;
  createdAt: string;
  changedBy: { id: string; name: string | null } | null;
};

export type OperationsSettings = {
  /** False until an operator has saved once; the value below is the default. */
  configured: boolean;
  unviewedOfferRefundWindowHours: number;
  minUnviewedOfferRefundWindowHours: number;
  maxUnviewedOfferRefundWindowHours: number;
  defaultUnviewedOfferRefundWindowHours: number;
  /** The exact sentence a provider is shown for an offer created right now. */
  unviewedOfferRefundNotice: string;
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null } | null;
  recentChanges: OperationsSettingsChange[];
};

export const OPERATIONS_SETTING_LABELS: Record<string, string> = {
  unviewedOfferRefundWindowHours: 'Görüntülenmeyen teklif için kredi iade süresi (saat)',
  entitlementRenewalSchedulerEnabled: 'Paket yenileme işi',
  unviewedOfferRefundSchedulerEnabled: 'Görüntülenmeyen teklif iade işi',
  requestExpirySchedulerEnabled: 'Talep süresi dolum işi',
  requestReminderSchedulerEnabled: 'Talep hatırlatma işi',
  showcaseLeadSlaSchedulerEnabled: 'Vitrin talebi yanıt süresi işi',
  showcasePlacementExpirySchedulerEnabled: 'Vitrin yerleşimi süre dolumu işi',
  marketplaceAutoPublishEnabled: 'Pazar taleplerinin otomatik yayını',
  providerReviewsEnabled: 'Hizmet veren değerlendirmeleri',
};

/* ---- scheduled jobs ------------------------------------------------------ */

/**
 * The background jobs a super admin switches on and off.
 *
 * The keys are the API's, verbatim: they are the path segment a toggle posts
 * to and the identity the audit trail keeps, so they are never translated. The
 * Turkish copy lives below, next to the rest of this panel's copy.
 *
 * This list mirrors `SCHEDULER_JOB_KEYS` on the API side, and the mirroring is
 * checked by the type below rather than by anybody remembering: a job the API
 * returns and this panel has no copy for renders an undefined name, so adding
 * one there means adding one here.
 */
export const SCHEDULER_JOB_KEYS = [
  'entitlement-renewal',
  'unviewed-offer-refund',
  'request-expiry',
  'request-reminder',
  'showcase-lead-sla',
  'showcase-placement-expiry',
] as const;

export type SchedulerJobKey = (typeof SCHEDULER_JOB_KEYS)[number];

export type SchedulerRunRecord = {
  startedAt: string;
  finishedAt: string;
  outcome: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  /** Counts only — never an id, an address or a provider's error text. */
  summary: string | null;
};

export type SchedulerJob = {
  key: SchedulerJobKey;
  enabled: boolean;
  /** The deployment's schedule. Shown, never edited here. */
  cron: string;
  /** True for the two jobs whose passes move credits. */
  movesMoney: boolean;
  /** What the API instance that answered last saw this job do, or null. */
  lastRun: SchedulerRunRecord | null;
};

export type SchedulerSettings = {
  jobs: SchedulerJob[];
  recentChanges: OperationsSettingsChange[];
};

/**
 * What each job is, in one line, and what switching it on actually starts.
 *
 * `impact` is written for somebody deciding whether to flip the switch during
 * an incident, so it says what the job *does to the data* rather than what it
 * is called. The two that move credits say so first.
 */
export const SCHEDULER_JOB_COPY: Record<
  SchedulerJobKey,
  { name: string; impact: string; confirmation?: string }
> = {
  'entitlement-renewal': {
    name: 'Paket yenileme',
    impact:
      'Süresi dolan dönemsel paketleri yeniler veya sona erdirir; yenileme tahsilatı başlatır.',
    confirmation:
      'Bu iş para hareketi üretir: açtığınızda, dönem sonu gelen paketler için yenileme ' +
      'denemesi başlar ve hizmet verenlerin erişim süresi buna göre değişir.',
  },
  'unviewed-offer-refund': {
    name: 'Görüntülenmeyen teklif iadesi',
    impact:
      'Müşterinin süresi içinde açmadığı teklifler için hizmet verenin teklif kredisini iade eder.',
    confirmation:
      'Bu iş kredi hareketi üretir: açtığınızda, iade süresi dolmuş görüntülenmemiş teklifler ' +
      'için krediler hizmet verenlere geri yüklenir ve iade e-postası gönderilir.',
  },
  'request-expiry': {
    name: 'Talep süresi dolumu',
    impact:
      '14 gündür açık olan onaylı talepleri kapatır; müşteriye ve teklif vermiş hizmet ' +
      'verenlere bilgilendirme e-postası gönderir.',
  },
  'request-reminder': {
    name: 'Talep hatırlatması',
    impact:
      '7 gündür teklif almamış onaylı talepler için müşteriye tek bir hatırlatma e-postası ' +
      'gönderir.',
  },
  'showcase-lead-sla': {
    name: 'Vitrin talebi yanıt süresi',
    // Written for somebody deciding during an incident: what it does to the
    // data, and — just as important — what it deliberately does not do.
    impact:
      'Kart sahibinin taahhüt ettiği süre içinde yanıtlanmayan vitrin taleplerini “süre doldu” ' +
      'olarak işaretler ve müşteriye kararını sorar. Talebi kendiliğinden genel pazara açmaz; ' +
      'bunu yalnız müşterinin kendi kararı yapar. 14 gün karar verilmeyen talepler kapanır.',
  },
  'showcase-placement-expiry': {
    name: 'Vitrin yerleşimi süre dolumu',
    impact:
      'Satın alınan süresi biten vitrin yerleşimlerini kapatır ve kartı sonraki paket için ' +
      'serbest bırakır. Yayın açısından gerekli değildir: ana sayfa süreyi kendisi kontrol ' +
      'eder, bu yüzden iş kapalıyken de süresi dolmuş bir kart gösterilmez.',
  },
};

/* ---- marketplace auto-publish ------------------------------------------- */

/**
 * The switch that decides whether a submitted marketplace request waits for a
 * moderator or goes straight to the matching providers. Read and written on
 * its own endpoint; the change list is the same audit shape the other
 * operations settings use.
 */
export type MarketplacePublishSettings = {
  enabled: boolean;
  recentChanges: OperationsSettingsChange[];
};

/**
 * The campaign engine's switch (CMP-004 S4): the same shape as the
 * auto-publish one, on `/operations-settings/campaign-engine`. Off by
 * default and read fail-closed by every engine path; only a SUPER_ADMIN
 * reads or writes it, and the screen asks for an explicit confirmation.
 */
export type CampaignEngineSettings = {
  enabled: boolean;
  recentChanges: OperationsSettingsChange[];
};

/**
 * The provider-review switch: the same shape as the auto-publish one, on
 * its own endpoint (`/operations-settings/provider-reviews`). Off by
 * default and fail-closed on the API side; only a SUPER_ADMIN reads or
 * writes it, which is every operator this app admits.
 */
export type ProviderReviewSettings = MarketplacePublishSettings;

/* ---- provider reviews ---------------------------------------------------- */

// The reasons, resolutions, actions and their labels live in `./reviews`,
// which is client-safe (the moderation form is a Client Component and cannot
// pull in this module's next/headers import). Re-exported here so server code
// keeps one import.
export * from './reviews';

/** The provider's own figures — every live review, no public threshold. */
export type ReviewSummary = {
  count: number;
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
};

/** One row of the provider's list, as the operator reads it through the provider route. */
export type ProviderReviewItem = {
  id: string;
  rating: number;
  comment: string | null;
  commentRemoved: boolean;
  createdAt: string;
  request: { id: string; requestNumber: string | null; categoryName: string };
  myReport: {
    reason: ReviewReportReason;
    createdAt: string;
    resolution: ReviewReportResolution | null;
  } | null;
};

export type ProviderReviewsPage = {
  summary: ReviewSummary;
  items: ProviderReviewItem[];
  nextCursor: string | null;
};

/** One report on the operator's queue, with enough of its review to triage it. */
export type ReviewReportQueueItem = {
  report: {
    id: string;
    reason: ReviewReportReason;
    note: string | null;
    createdAt: string;
    resolvedAt: string | null;
    resolution: ReviewReportResolution | null;
  };
  review: {
    id: string;
    rating: number;
    commentExcerpt: string;
    commentRemoved: boolean;
    removed: boolean;
    createdAt: string;
  };
  provider: { id: string; businessName: string };
  request: { id: string; requestNumber: string | null; categoryName: string };
  lastDecision: {
    action: ReviewModerationAction;
    reason: ReviewReportReason | null;
    createdAt: string;
  } | null;
};

export type ReviewReportQueue = {
  items: ReviewReportQueueItem[];
  nextCursor: string | null;
};

/**
 * Everything an operator may see about one review: the text even after its
 * removal, the customer's name, every report with its note, and the log.
 */
export type AdminReviewDetail = {
  id: string;
  rating: number;
  comment: string | null;
  commentRemoved: boolean;
  commentRemovedAt: string | null;
  removed: boolean;
  removedAt: string | null;
  createdAt: string;
  provider: { id: string; businessName: string };
  request: {
    id: string;
    requestNumber: string | null;
    categoryName: string;
    city: string;
    district: string;
    customerName: string;
  };
  reports: Array<{
    id: string;
    reason: ReviewReportReason;
    note: string | null;
    createdAt: string;
    resolvedAt: string | null;
    resolution: ReviewReportResolution | null;
    resolutionNote: string | null;
    reporter: { id: string; businessName: string };
    resolvedBy: { id: string; name: string | null } | null;
  }>;
  moderation: Array<{
    id: string;
    action: ReviewModerationAction;
    reason: ReviewReportReason | null;
    note: string | null;
    createdAt: string;
    performedBy: { id: string; name: string | null };
  }>;
};

/** The customer's review state for one request, as the operator reads it on the request screen. */
export type CustomerReviewState = {
  eligibility: 'ok' | 'disabled' | 'not-completed' | 'window-closed' | 'already-reviewed' | 'removed';
  windowEndsAt: string | null;
  provider: { id: string; businessName: string } | null;
  review: {
    id: string;
    rating: number;
    comment: string | null;
    createdAt: string;
    commentRemoved: boolean;
    removed: boolean;
    removalReason: ReviewReportReason | null;
  } | null;
};

/* ---- request reports ----------------------------------------------------- */

/**
 * A provider's reason for reporting a request. The same seven keys double as
 * the operator's removal reasons, so a reporter's reason can be carried over
 * one-to-one when the report is upheld.
 */
export const REPORT_REASON_KEYS = [
  'SPAM',
  'FAKE_OR_TEST',
  'CONTAINS_CONTACT_INFO',
  'WRONG_CATEGORY',
  'INAPPROPRIATE_CONTENT',
  'DUPLICATE',
  'OTHER',
] as const;

export type ReportReason = (typeof REPORT_REASON_KEYS)[number];
export type RemovalReason = ReportReason;

export type RequestReportResolution = 'DISMISSED' | 'REQUEST_REMOVED';

/**
 * The operator's spelling of a reporter's reason. Mirrors the API's
 * `REPORT_REASON_ADMIN_LABELS` (`request-report-copy.ts`), copied because the
 * admin app cannot import the API. Shown to operators only.
 */
export const REPORT_REASON_ADMIN_LABELS: Record<ReportReason, string> = {
  SPAM: 'Spam / anlamsız',
  FAKE_OR_TEST: 'Sahte / deneme',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  WRONG_CATEGORY: 'Yanlış kategori',
  INAPPROPRIATE_CONTENT: 'Uygunsuz içerik',
  DUPLICATE: 'Mükerrer',
  OTHER: 'Diğer',
};

/**
 * What the customer is told when their request is removed — the exact sentence
 * the API stores as the request's rejection reason and mails out. Mirrors the
 * API's `REMOVAL_REASON_CUSTOMER_LABELS`; shown beside each removal option so
 * the operator sees the words the customer will read before choosing them.
 */
export const REMOVAL_REASON_CUSTOMER_LABELS: Record<RemovalReason, string> = {
  SPAM: 'Talep içeriği platform kurallarına uygun bulunmadı',
  FAKE_OR_TEST: 'Talep gerçek bir hizmet ihtiyacı olarak değerlendirilemedi',
  CONTAINS_CONTACT_INFO: 'Talep metninde iletişim bilgisi paylaşımı',
  WRONG_CATEGORY: 'Talep seçilen hizmet kategorisine uygun değil',
  INAPPROPRIATE_CONTENT: 'Talep içeriği uygunsuz bulundu',
  DUPLICATE: 'Aynı hizmet için birden fazla talep açılmış',
  OTHER: 'Talep platform kurallarına uygun bulunmadı',
};

export const REPORT_RESOLUTION_LABELS: Record<RequestReportResolution, string> = {
  DISMISSED: 'Uygun bulundu',
  REQUEST_REMOVED: 'Talep kaldırıldı',
};

export function reportReasonLabel(reason: string): string {
  return (REPORT_REASON_ADMIN_LABELS as Record<string, string>)[reason] ?? reason;
}

export function reportResolutionLabel(resolution: string): string {
  return (REPORT_RESOLUTION_LABELS as Record<string, string>)[resolution] ?? resolution;
}

/** One row of the operator's report queue: a request, with its reports folded in. */
export type RequestReportQueueItem = {
  request: {
    id: string;
    requestNumber: string | null;
    status: ServiceRequestStatus;
    categoryName: string;
    city: string;
    district: string;
    submittedAt: string;
    descriptionExcerpt: string;
  };
  reportCount: number;
  reasons: ReportReason[];
  reporters: Array<{ id: string; businessName: string }>;
  firstReportedAt: string;
  lastResolution: { resolution: RequestReportResolution; resolvedAt: string } | null;
  /**
   * Derived by the API, never stored: the last decision removed the request
   * and an operator has since put it back.
   */
  reopened: boolean;
};

export type RequestReportQueue = {
  items: RequestReportQueueItem[];
  nextCursor: string | null;
};

/** One report of one request, as the detail page lists them. Operator-only. */
export type RequestReport = {
  id: string;
  reason: ReportReason;
  /** The reporter's free text. Never shown outside the admin panel. */
  note: string | null;
  createdAt: string;
  reporter: { id: string; businessName: string };
  resolvedAt: string | null;
  resolution: RequestReportResolution | null;
  resolutionNote: string | null;
  resolvedBy: { id: string; name: string | null } | null;
};

/* ---- support tickets ----------------------------------------------------- */

export const SUPPORT_TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/**
 * The two desks the queue holds, in the order the filter offers them.
 *
 * Hizmet alan first because it is the older half of the queue and by far the
 * larger one; the order is otherwise arbitrary and is fixed here so the select,
 * the row badge and the tests all read it from one place.
 */
export const SUPPORT_TICKET_REQUESTER_ROLES = ['CUSTOMER', 'PROVIDER'] as const;

export type SupportTicketRequesterRole = (typeof SUPPORT_TICKET_REQUESTER_ROLES)[number];

const SUPPORT_TICKET_REQUESTER_ROLE_LABELS: Record<SupportTicketRequesterRole, string> = {
  CUSTOMER: 'Hizmet alan',
  PROVIDER: 'Hizmet veren',
};

/**
 * What a desk is called on screen.
 *
 * Falls back to printing the raw value rather than guessing, for the reason
 * {@link supportTicketStatusLabel} does: a build that meets a third desk should
 * show an operator a word they can search for, not silently file it under one
 * of the two it knows.
 */
export function supportTicketRequesterRoleLabel(role: string): string {
  return SUPPORT_TICKET_REQUESTER_ROLE_LABELS[role as SupportTicketRequesterRole] ?? role;
}

/**
 * The badge a row wears to say which side of the marketplace is waiting.
 *
 * Two visibly different tags rather than one neutral chip with different text:
 * the queue is scanned, not read, and an operator picking a hizmet veren's
 * ticket out of a page of hizmet alan ones should not have to read a word to
 * find it.
 */
export function supportTicketRequesterRoleBadgeClass(role: string): string {
  return role === 'PROVIDER' ? 'tag tag-ink' : 'tag tag-neutral';
}

const SUPPORT_TICKET_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  OPEN: 'Açık',
  IN_PROGRESS: 'İşlemde',
  RESOLVED: 'Çözüldü',
  CLOSED: 'Kapatıldı',
};

export function supportTicketStatusLabel(status: string): string {
  return SUPPORT_TICKET_STATUS_LABELS[status as SupportTicketStatus] ?? status;
}

export function supportTicketStatusBadgeClass(status: string): string {
  switch (status) {
    case 'OPEN':
      return 'badge badge-warning';
    case 'IN_PROGRESS':
      return 'badge badge-info';
    case 'RESOLVED':
      return 'badge badge-success';
    case 'CLOSED':
      return 'badge badge-muted';
    default:
      return 'badge';
  }
}

/**
 * What the button for one transition says.
 *
 * The API decides which transitions a ticket may make and returns them; this
 * only decides how each one reads. A move the table does not allow never gets a
 * label because it never gets a button.
 */
export function supportTicketTransitionLabel(status: string): string {
  switch (status) {
    case 'OPEN':
      return 'Yeniden aç';
    case 'IN_PROGRESS':
      return 'İşleme al';
    case 'RESOLVED':
      return 'Çözüldü olarak işaretle';
    case 'CLOSED':
      return 'Talebi kapat';
    default:
      return supportTicketStatusLabel(status);
  }
}

/** What a recorded status change says on the timeline. */
export function supportTicketStatusChangeLabel(toStatus: string): string {
  switch (toStatus) {
    case 'OPEN':
      return 'Talep yeniden açık duruma alındı.';
    case 'IN_PROGRESS':
      return 'Talep işleme alındı.';
    case 'RESOLVED':
      return 'Talep çözüldü olarak işaretlendi.';
    case 'CLOSED':
      return 'Talep kapatıldı.';
    default:
      return `Talep durumu ${supportTicketStatusLabel(toStatus)} olarak güncellendi.`;
  }
}

/**
 * One ticket in the operator's queue.
 *
 * The requester block is the identity an operator needs in order to answer —
 * the name and the address every other admin screen already shows — and nothing
 * more. No phone, no password state, no session, no payment fact.
 *
 * It is called `requester` rather than `customer` because the queue now holds
 * both sides of the marketplace, and `requesterRole` says which this one is.
 * That value is the ticket's own snapshot from the moment it was opened, not
 * the account's current role, so a row keeps saying what it said even if the
 * account behind it changes.
 */
export type SupportTicketListEntry = {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  requesterRole: SupportTicketRequesterRole;
  lastActivityAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  requester: { id: string; name: string | null; email: string | null };
};

export type SupportTicketListResponse = {
  items: SupportTicketListEntry[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  /** Behind the status filter's options, within the desk currently chosen. */
  statusCounts: Record<SupportTicketStatus, number>;
  /** And behind the desk filter's options, under the status filter chosen. */
  requesterRoleCounts: Record<SupportTicketRequesterRole, number>;
};

export type SupportTicketTimelineEntry =
  | PackageRefundTimelineEntry
  | {
      kind: 'MESSAGE';
      id: string;
      /** PROVIDER joined the pair when the desk opened to hizmet verenler. */
      authorRole: 'CUSTOMER' | 'ADMIN' | 'PROVIDER';
      /** True when this operator wrote it themselves. */
      mine: boolean;
      body: string;
      createdAt: string;
    }
  | {
      kind: 'STATUS_CHANGE';
      id: string;
      fromStatus: SupportTicketStatus | null;
      toStatus: SupportTicketStatus;
      createdAt: string;
    };

export type SupportTicketDetail = SupportTicketListEntry & {
  canReply: boolean;
  /** Exactly the moves this ticket may make right now, decided by the API. */
  allowedTransitions: SupportTicketStatus[];
  /** CMP-006 PR-B: what the requester chose the ticket to be about. */
  topic: 'GENERAL' | 'PACKAGE_AND_CREDIT_REFUND';
  /**
   * CMP-006 PR-B: null unless this operator holds PACKAGE_REFUND_READ. The
   * candidates are filled only when this operator may open a request here now.
   */
  packageRefund: {
    request: { id: string; status: PackageRefundRequestStatus } | null;
    canOpen: boolean;
    candidatePurchases: {
      id: string;
      purchaseNumber: string | null;
      packageName: string;
      priceAmount: number;
      currency: string;
      paidAt: string | null;
      recommendation: PackageRefundRecommendation;
    }[];
  } | null;
  timeline: SupportTicketTimelineEntry[];
};

// ── Paket iadeleri (CMP-006 PR-B) ──────────────────────────────────────────

export type PackageRefundRequestStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'REJECTED'
  | 'APPROVED_PENDING_SETTLEMENT'
  | 'SETTLED'
  | 'SETTLEMENT_FAILED'
  | 'WITHDRAWN';

export const PACKAGE_REFUND_STATUSES: PackageRefundRequestStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED_PENDING_SETTLEMENT',
  'SETTLED',
  'SETTLEMENT_FAILED',
  'REJECTED',
  'WITHDRAWN',
];

export type PackageRefundRecommendation = 'REFUNDABLE' | 'EXCEPTION_ONLY' | 'NOT_APPLICABLE';
export type PackageRefundExceptionGround =
  | 'STATUTORY_RIGHT'
  | 'UNAUTHORIZED_TRANSACTION'
  | 'DUPLICATE_CHARGE'
  | 'PLATFORM_SERVICE_FAULT';

export const PACKAGE_REFUND_EXCEPTION_GROUNDS: PackageRefundExceptionGround[] = [
  'STATUTORY_RIGHT',
  'UNAUTHORIZED_TRANSACTION',
  'DUPLICATE_CHARGE',
  'PLATFORM_SERVICE_FAULT',
];

export type PackageRefundEligibility = {
  purchaseId: string;
  recommendation: PackageRefundRecommendation;
  summary: string;
  reasons: { code: string; blocking: boolean; explanation: string }[];
  blockingCodes: string[];
  evaluatedAt: string;
  paidAt: string | null;
  windowEndsAt: string | null;
};

export type PackageRefundTimelineEntry = {
  kind: 'PACKAGE_REFUND_EVENT';
  id: string;
  action: string;
  toStatus: PackageRefundRequestStatus;
  statusLabel: string;
  fromStatus: PackageRefundRequestStatus | null;
  actorKind: 'PROVIDER' | 'ADMIN' | 'PAYMENT_WEBHOOK';
  actor: { id: string; name: string | null } | null;
  note: string | null;
  createdAt: string;
};

export type PackageRefundPurchase = {
  id: string;
  purchaseNumber: string | null;
  packageName: string;
  creditAmount: number;
  priceAmount: number;
  currency: string;
  paidAt: string | null;
};

export type PackageRefundListItem = {
  id: string;
  status: PackageRefundRequestStatus;
  statusLabel: string;
  origin: 'PROVIDER' | 'ADMIN';
  submittedRecommendation: PackageRefundRecommendation;
  approvalKind: 'NORMAL' | 'EXCEPTION' | null;
  exceptionGround: PackageRefundExceptionGround | null;
  supportTicketId: string;
  createdAt: string;
  updatedAt: string;
  provider: { id: string; businessName: string };
  purchase: PackageRefundPurchase;
};

export type PackageRefundListResponse = {
  items: PackageRefundListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  statusCounts: Record<PackageRefundRequestStatus, number>;
};

type StaffRef = { id: string; name: string | null } | null;

export type PackageRefundDetail = PackageRefundListItem & {
  purchase: PackageRefundPurchase & { kind: string; status: string; refundedAt: string | null };
  supportTicket: { id: string; subject: string; status: SupportTicketStatus; topic: string };
  createdBy: { id: string; name: string | null; role: string };
  reviewStartedBy: StaffRef;
  approvedBy: StaffRef;
  rejectedBy: StaffRef;
  settlementFailedBy: StaffRef;
  submittedEligibility: PackageRefundEligibility;
  approvalEligibility: PackageRefundEligibility | null;
  currentEligibility: PackageRefundEligibility;
  exceptionReason: string | null;
  rejectionReason: string | null;
  settlementFailureReason: string | null;
  reviewStartedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
  settledAt: string | null;
  settledByWebhook: boolean;
  settlementFailedAt: string | null;
  /** True when a signed webhook that did not prove a full refund recorded the failure. */
  settlementFailedByWebhook: boolean;
  creditClawbackCredits: number;
  termsEvidence: { documentVersion: string; acceptedAt: string } | null;
  events: PackageRefundTimelineEntry[];
  flowOpen: boolean;
  allowedActions: {
    take: boolean;
    approveNormal: boolean;
    approveException: boolean;
    reject: boolean;
    markSettlementFailed: boolean;
  };
  exceptionBlockedByMakerChecker: boolean;
};

export function packageRefundStatusBadgeClass(status: PackageRefundRequestStatus): string {
  switch (status) {
    case 'SETTLED':
      return 'badge badge-good';
    case 'REJECTED':
    case 'SETTLEMENT_FAILED':
      return 'badge badge-bad';
    case 'WITHDRAWN':
      return 'badge badge-muted';
    default:
      return 'badge badge-warn';
  }
}

export const PACKAGE_REFUND_STATUS_LABELS: Record<PackageRefundRequestStatus, string> = {
  SUBMITTED: 'Gönderildi',
  UNDER_REVIEW: 'İnceleniyor',
  REJECTED: 'Reddedildi',
  APPROVED_PENDING_SETTLEMENT: 'Onaylandı, ödeme iadesi bekleniyor',
  SETTLED: 'Ödeme iadesi tamamlandı',
  SETTLEMENT_FAILED: 'Ödeme iadesi tamamlanamadı',
  WITHDRAWN: 'Geri çekildi',
};

export const PACKAGE_REFUND_RECOMMENDATION_LABELS: Record<PackageRefundRecommendation, string> = {
  REFUNDABLE: 'Normal iadeye uygun',
  EXCEPTION_ONLY: 'Yalnız istisna ile',
  NOT_APPLICABLE: 'İade edilecek ödeme yok',
};

export const PACKAGE_REFUND_EXCEPTION_GROUND_LABELS: Record<PackageRefundExceptionGround, string> = {
  STATUTORY_RIGHT: 'Zorunlu kanuni hak',
  UNAUTHORIZED_TRANSACTION: 'Doğrulanmış yetkisiz işlem',
  DUPLICATE_CHARGE: 'Çift tahsilat',
  PLATFORM_SERVICE_FAULT: 'TakTic kaynaklı hizmet kusuru',
};

export const PACKAGE_REFUND_ACTOR_LABELS: Record<PackageRefundTimelineEntry['actorKind'], string> = {
  PROVIDER: 'Hizmet veren',
  ADMIN: 'Yönetici',
  PAYMENT_WEBHOOK: 'Ödeme sağlayıcısı bildirimi',
};

// ── Vitrin (showcase) ───────────────────────────────────────────────────────

export type ShowcaseCardKind = 'SERVICE' | 'PROMOTION';

export type ShowcaseCardStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'ARCHIVED';

export type ShowcaseVersionReview = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';

export type ShowcaseCardArea = {
  id: string;
  scope: 'CITY' | 'DISTRICT' | 'NEIGHBORHOOD';
  city: string;
  district: string | null;
  neighborhood: string | null;
  /** Server-derived comparison key; the identity the narrowing rule uses. */
  areaKey: string;
  label: string;
};

export type ShowcaseCardReviewRecord = {
  id: string;
  decision: ShowcaseVersionReview;
  note: string | null;
  createdAt: string;
  reviewedBy: { id: string; name: string | null; email: string } | null;
};

export type ShowcaseCardVersion = {
  id: string;
  versionNumber: number;
  kind: ShowcaseCardKind;
  title: string;
  summary: string;
  scopeIncluded: string[];
  scopeExcluded: string[];
  /**
   * The provider's own price to their own customer, in minor units. Not money
   * TakTick handles — it is deliberately named apart from
   * `PackagePurchase.priceAmountSnapshot`, which is what the platform charges.
   */
  listedServicePriceAmount: number | null;
  listedServiceCurrency: string;
  imageUrl: string | null;
  responseSlaUrgentHours: number;
  responseSlaNormalHours: number;
  priceTermsVersion: string | null;
  priceTermsAcceptedAt: string | null;
  reviewStatus: ShowcaseVersionReview;
  submittedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  areas: ShowcaseCardArea[];
  review: ShowcaseCardReviewRecord | null;
};

export type ShowcaseCard = {
  id: string;
  kind: ShowcaseCardKind;
  status: ShowcaseCardStatus;
  category: { id: string; name: string; slug: string; kind: CategoryKind; status: string };
  liveVersion: ShowcaseCardVersion | null;
  draftVersion: ShowcaseCardVersion | null;
  /** The newest refused version, only while the card has neither a draft nor a live one. */
  rejectedVersion: ShowcaseCardVersion | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ShowcaseProviderSummary = {
  id: string;
  businessName: string;
  status: ProviderStatus;
};

export type ShowcaseVersionListEntry = ShowcaseCardVersion & {
  card: ShowcaseCard;
  provider: ShowcaseProviderSummary;
};

/**
 * One version with everything an operator needs to decide about it.
 *
 * `provider.serviceAreas` is the reason this is a different shape from the list:
 * judging a claim about "İstanbul/Kadıköy" means seeing the coverage the
 * business itself declared, so the operator can tell a legitimate card from one
 * reaching past what its owner does.
 *
 * `autoPublish` is non-null only on a version the narrowing rule published
 * without an operator. It is here so a reviewer looking at a card's history can
 * tell those apart from the ones somebody decided.
 */
export type ShowcaseVersionDetail = ShowcaseCardVersion & {
  card: ShowcaseCard;
  provider: ShowcaseProviderSummary & {
    contactName: string;
    city: string;
    district: string;
    serviceAreas: Array<{
      scope: 'CITY' | 'DISTRICT' | 'NEIGHBORHOOD';
      city: string;
      district: string | null;
      neighborhood: string | null;
    }>;
  };
  autoPublish: {
    id: string;
    previousVersionId: string;
    removedAreaKeys: string[];
    createdAt: string;
  } | null;
  /**
   * The reserved right this card would go live under — null when it holds
   * none. Only meaningful for a first publication: a revision replaces an
   * already-live card and consumes no right of its own, so a reviewer only
   * needs this to judge whether approval is possible at all.
   */
  entitlement: {
    packageName: string;
    durationDays: number;
    expiresAt: string;
    pausedForReview: boolean;
    valid: boolean;
  } | null;
};

export type ShowcaseCardListEntry = ShowcaseCard & { provider: ShowcaseProviderSummary };

export const SHOWCASE_CARD_STATUS_LABELS: Record<ShowcaseCardStatus, string> = {
  DRAFT: 'Taslak',
  PENDING_REVIEW: 'İncelemede',
  APPROVED: 'Onaylı',
  REJECTED: 'Reddedildi',
  SUSPENDED: 'Askıya alındı',
  ARCHIVED: 'Arşivlendi',
};

export const SHOWCASE_VERSION_REVIEW_LABELS: Record<ShowcaseVersionReview, string> = {
  DRAFT: 'Taslak',
  PENDING: 'İncelemede',
  APPROVED: 'Onaylı',
  REJECTED: 'Reddedildi',
};

export const SHOWCASE_CARD_KIND_LABELS: Record<ShowcaseCardKind, string> = {
  SERVICE: 'Hizmet vitrini',
  PROMOTION: 'Genel tanıtım',
};

export function showcaseStatusBadgeClass(status: ShowcaseCardStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'badge badge-good';
    case 'PENDING_REVIEW':
      return 'badge badge-warn';
    case 'REJECTED':
    case 'SUSPENDED':
      return 'badge badge-bad';
    default:
      return 'badge badge-muted';
  }
}

export function showcaseReviewBadgeClass(review: ShowcaseVersionReview): string {
  switch (review) {
    case 'APPROVED':
      return 'badge badge-good';
    case 'PENDING':
      return 'badge badge-warn';
    case 'REJECTED':
      return 'badge badge-bad';
    default:
      return 'badge badge-muted';
  }
}

// ── Vitrin phase two: the catalogue, the paid runs and the direct leads ──────

export type ShowcasePlacementStatus =
  | 'PENDING_ACTIVATION'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'EXPIRED'
  | 'CANCELLED';

export type ShowcasePlacementSuspendReason =
  | 'ADMIN_ACTION'
  | 'CATEGORY_CLOSED'
  | 'SYSTEM_PUBLISH_BLOCK'
  | 'CARD_ARCHIVED'
  | 'AREA_NO_LONGER_COVERED'
  | 'PROVIDER_NOT_APPROVED';

export type ShowcaseLeadStatus =
  | 'OPEN'
  | 'ANSWERED'
  | 'BREACHED'
  | 'RELEASED'
  | 'CLOSED_UNANSWERED';

export type ShowcaseLeadUrgency = 'URGENT' | 'NORMAL';

export type ShowcaseLeadFallbackDecision = 'RELEASE' | 'KEEP_CLOSED';

export type ShowcaseLeadCloseReason =
  | 'CUSTOMER_KEPT_CLOSED'
  | 'CUSTOMER_CANCELLED'
  | 'MODERATION_REJECTED'
  | 'REQUEST_EXPIRED';

/**
 * A vitrin package as the operator maintains it.
 *
 * The slug is read-only after creation, and the screen says why: it is the key
 * into the payment provider's variant map, so renaming one detaches every
 * future checkout from the variant it was mapped to — and the failure surfaces
 * as a provider who paid and got a VARIANT_MISMATCH.
 */
export type ShowcasePackage = {
  id: string;
  name: string;
  slug: string;
  priceAmount: number;
  currency: string;
  durationDays: number;
  /**
   * How long a purchased-but-unused right stays reserved for one card, in
   * days, counted from payment. Review time does not consume it — a version
   * sitting in the queue does not burn the clock the way an operator's delay
   * would.
   */
  activationWindowDays: number;
  allowedCardKind: ShowcaseCardKind | null;
  maxAreas: number | null;
  requiresAdminApproval: boolean;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ShowcasePlacementSuspension = {
  id: string;
  reason: ShowcasePlacementSuspendReason;
  /** Whether this interval pushed the run's end forward. Snapshotted, not derived. */
  extendsClock: boolean;
  startedAt: string;
  endedAt: string | null;
  endAtBefore: string;
  endAtAfter: string | null;
  note: string | null;
  actor: { id: string; name: string | null } | null;
};

export type ShowcasePlacement = {
  id: string;
  status: ShowcasePlacementStatus;
  cardId: string;
  kind: ShowcaseCardKind;
  category: { id: string; name: string; slug: string };
  version: { id: string; versionNumber: number; title: string };
  packageName: string;
  priceAmount: number;
  currency: string;
  durationDays: number;
  startAt: string;
  endAt: string;
  suspendedAt: string | null;
  suspendReason: ShowcasePlacementSuspendReason | null;
  extendedDays: number;
  cancelledAt: string | null;
  createdAt: string;
  leadCount: number;
  areas: Array<{ id: string; scope: string; active: boolean; label: string }>;
  provider?: ShowcaseProviderSummary & { city: string; district: string };
  suspensions?: ShowcasePlacementSuspension[];
  versionChanges?: Array<{
    id: string;
    fromVersionId: string;
    toVersionId: string;
    trigger: 'ADMIN_APPROVAL' | 'AREA_NARROWING';
    createdAt: string;
  }>;
};

/**
 * A direct lead, for the operator's queue.
 *
 * Read-only. An operator's power over a lead is exercised through the request
 * it belongs to — refusing the request closes the lead in the same transaction
 * — and there is deliberately no route that releases one on the customer's
 * behalf: the database refuses a release without their own decision, and an
 * admin endpoint bypassing that would make the constraint decorative.
 *
 * No customer telephone number or e-mail address, exactly as on the provider's
 * inbox.
 */
/**
 * One provider accepting one version of the price-responsibility text.
 *
 * Append-only on the API side and read-only here: there is no admin route that
 * writes or clears one, deliberately. A record of consent an operator could
 * edit would say what the platform wanted rather than what a business agreed
 * to, and the table would stop being evidence.
 */
export type ShowcasePriceTermsAcceptance = {
  id: string;
  /** Null for a package-first acceptance: it is scoped to the business, not a card. */
  cardId: string | null;
  providerId: string;
  termsVersion: string;
  termsTextSnapshot: string;
  acceptedAt: string;
  scope: 'CARD' | 'PACKAGE';
  provider: { id: string; businessName: string; status: string };
  card: { id: string; kind: string; status: string; categoryId: string } | null;
  acceptedByUser: { id: string; name: string | null; email: string | null };
};

export type ShowcaseAdminLead = {
  id: string;
  status: ShowcaseLeadStatus;
  urgencyBucket: ShowcaseLeadUrgency;
  slaHoursSnapshot: number;
  slaDueAt: string;
  breachedAt: string | null;
  fallbackAskedAt: string | null;
  fallbackDecision: ShowcaseLeadFallbackDecision | null;
  fallbackDecidedAt: string | null;
  releasedAt: string | null;
  closedAt: string | null;
  closeReason: ShowcaseLeadCloseReason | null;
  respondedAt: string | null;
  createdAt: string;
  kindSnapshot: ShowcaseCardKind;
  listedPriceSnapshot: number | null;
  cardId: string;
  cardVersion: { id: string; versionNumber: number; title: string };
  provider: ShowcaseProviderSummary;
  request: {
    id: string;
    requestNumber: string | null;
    status: string;
    qualityScore: number;
    city: string;
    district: string;
    /** Non-null while the request is still reserved for one business. */
    directShowcaseProviderId: string | null;
    category: { id: string; name: string; slug: string };
    submittedAt: string;
  };
};

export const SHOWCASE_PLACEMENT_STATUS_LABELS: Record<ShowcasePlacementStatus, string> = {
  PENDING_ACTIVATION: 'Başlatılıyor',
  ACTIVE: 'Yayında',
  SUSPENDED: 'Yayında değil',
  EXPIRED: 'Süresi doldu',
  CANCELLED: 'İptal edildi',
};

/**
 * Why a run is off the air — and whether the paid clock is running.
 *
 * The clock is stated in the label rather than left to a second column, because
 * it is the operationally important half: an operator deciding whether to
 * compensate a provider needs to know whether the platform already did.
 */
export const SHOWCASE_SUSPEND_REASON_LABELS: Record<ShowcasePlacementSuspendReason, string> = {
  ADMIN_ACTION: 'Operatör kararı — süre durdu',
  CATEGORY_CLOSED: 'Kategori kapalı — süre durdu',
  SYSTEM_PUBLISH_BLOCK: 'Sistemsel yayın engeli — süre durdu',
  CARD_ARCHIVED: 'Sağlayıcı kartı arşivledi — süre işliyor',
  AREA_NO_LONGER_COVERED: 'Kart bölgesi kapsam dışı — süre işliyor',
  PROVIDER_NOT_APPROVED: 'Sağlayıcı onaylı değil — süre işliyor',
};

export const SHOWCASE_LEAD_STATUS_LABELS: Record<ShowcaseLeadStatus, string> = {
  OPEN: 'Yanıt bekliyor',
  ANSWERED: 'Teklif verildi',
  BREACHED: 'Süre doldu',
  RELEASED: 'Pazara açıldı',
  CLOSED_UNANSWERED: 'Kapandı',
};

export const SHOWCASE_LEAD_URGENCY_LABELS: Record<ShowcaseLeadUrgency, string> = {
  URGENT: 'Acil',
  NORMAL: 'Normal',
};

export function showcasePlacementBadgeClass(status: ShowcasePlacementStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'badge badge-good';
    case 'PENDING_ACTIVATION':
      return 'badge badge-warn';
    case 'SUSPENDED':
      return 'badge badge-warn';
    case 'CANCELLED':
      return 'badge badge-bad';
    default:
      return 'badge badge-muted';
  }
}

export function showcaseLeadBadgeClass(status: ShowcaseLeadStatus): string {
  switch (status) {
    case 'OPEN':
      return 'badge badge-warn';
    case 'ANSWERED':
      return 'badge badge-good';
    case 'BREACHED':
      return 'badge badge-bad';
    case 'RELEASED':
      return 'badge badge-muted';
    default:
      return 'badge badge-muted';
  }
}

// ────────────────────────────── Campaigns (CMP-002 S1) ──────────────────────────────

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';

export type CampaignActor = { id: string; name: string | null };

export type Campaign = {
  id: string;
  key: string;
  name: string;
  status: CampaignStatus;
  /** The version the engine evaluates while ACTIVE/PAUSED; null until the first activation (S2B2). */
  activeVersionId: string | null;
  /** Cumulative across versions, never decremented. */
  redemptionCount: number;
  budgetConsumedCredits: number;
  createdAt: string;
  updatedAt: string;
  createdBy: CampaignActor;
};

export type CampaignVersionSummary = {
  id: string;
  versionNumber: number;
  trigger: string;
  eligibilityFacts: string[];
  factSetKey: string | null;
  benefitType: string;
  benefitCredits: number;
  benefitExpiresInDays: number;
  maxRedemptionsPerProvider: number;
  maxRedemptionsGlobal: number | null;
  maxRedemptionsPerDay: number | null;
  budgetCredits: number | null;
  /** CMP-003 S3: revokes per UTC day before the campaign pauses itself; null = no threshold. */
  maxRevokesPerDay: number | null;
  windowStartAt: string | null;
  windowEndAt: string | null;
  stackPolicy: string;
  priority: number;
  /** CMP-006 PR-D: WEB | MOBILE | ALL — part of the immutable version; ALL on every version before the field. */
  channel: CampaignChannel;
  createdAt: string;
  createdBy: CampaignActor;
};

export type CampaignVersion = CampaignVersionSummary & { definition: unknown };

export type CampaignChannel = 'WEB' | 'MOBILE' | 'ALL';
export type CampaignSourceChannel = 'WEB' | 'MOBILE' | 'UNKNOWN';

/**
 * CMP-006 PR-D. The API's own answer to "would the activation gate find a
 * producer of this version's channel now?" — the panel only reflects it.
 */
export type CampaignChannelReadiness = {
  channel: CampaignChannel;
  available: boolean;
  missingSources: string[];
};

export type CampaignAuditAction =
  | 'CREATED'
  | 'VERSION_CREATED'
  | 'ACTIVATED'
  | 'VERSION_ACTIVATED'
  | 'PAUSED'
  | 'RESUMED'
  | 'ENDED'
  | 'AUTO_PAUSED'
  | 'REDEMPTION_REVOKED'
  | 'EVENT_RETRY_REQUESTED';

export type CampaignAuditEntry = {
  id: string;
  action: CampaignAuditAction;
  campaignVersionId: string | null;
  /** The person, or null for the system's own acts (CMP-004 S4: a payment reversal's revoke or auto-pause). */
  actor: CampaignActor | null;
  summary: {
    versionNumber?: number | null;
    previousActiveVersionNumber?: number | null;
    trigger?: string;
    benefitCredits?: number;
    benefitExpiresInDays?: number;
    maxRedemptionsPerProvider?: number;
    /** CMP-006 PR-D: on VERSION_CREATED / VERSION_ACTIVATED; absent on older rows (= ALL). */
    channel?: CampaignChannel;
    changedFields?: string[];
    reason?: string;
    /** SYSTEM on a payment reversal's revoke / auto-pause (actor null since CMP-004 S4; nominal on older rows), ADMIN otherwise. */
    actorKind?: 'SYSTEM' | 'ADMIN';
    source?: string;
    revokeCount?: number;
    maxRevokesPerDay?: number;
    redemptionId?: string;
    revokedCredits?: number;
    spentAtRevoke?: number;
    triggerEventKey?: string;
    previousStatus?: string;
    attemptCount?: number;
    /** BUG-OPS-002: on ENDED since then — DRAFT means a draft closed without ever running; absent on older rows. */
    fromStatus?: CampaignStatus;
  } | null;
  createdAt: string;
};

// ───────────────────────── operations desk (CMP-003 S3) ─────────────────────────

export type CampaignRedemptionStatus = 'GRANTED' | 'REVOKED' | 'EXPIRED';
export type PromoCreditLotStatus = 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'REVOKED';

export type CampaignRedemption = {
  id: string;
  status: CampaignRedemptionStatus;
  versionNumber: number;
  trigger: string;
  triggerEventKey: string;
  provider: { id: string; businessName: string };
  purchaseId: string | null;
  grantedCredits: number;
  grantedAt: string;
  grantTransactionId: string | null;
  lot: { id: string; status: PromoCreditLotStatus; remainingCredits: number; expiresAt: string } | null;
  revokedAt: string | null;
  revokeReason: 'PAYMENT_REVERSED' | 'ADMIN_REVOKED' | null;
  spentAtRevoke: number | null;
  revokedCredits: number | null;
  revokedBy: CampaignActor | null;
  revokeNote: string | null;
  revokedByWebhookEventId: string | null;
};

export type CampaignTriggerEventStatus = 'PENDING' | 'PROCESSING' | 'EVALUATED' | 'SETTLED' | 'RETRY_WAIT';

export type CampaignEvaluationEvent = {
  id: string;
  triggerEventKey: string;
  trigger: string;
  providerId: string;
  purchaseId: string | null;
  status: CampaignTriggerEventStatus;
  attemptCount: number;
  evaluationCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  nextAttemptAt: string;
  leaseUntil: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  settledByCampaignId: string | null;
  settledAt: string | null;
  /** CMP-006 PR-D: server-derived; UNKNOWN when nobody could vouch for it. */
  sourceChannel: CampaignSourceChannel;
  lastOutcome: { outcome: string; reasonCode: string | null; evaluatedAt: string } | null;
  retryable: boolean;
};

export type CampaignRedemptionPage = { items: CampaignRedemption[]; nextCursor: string | null };
export type CampaignEvaluationEventPage = { items: CampaignEvaluationEvent[]; nextCursor: string | null };

export function campaignRedemptionStatusLabel(status: CampaignRedemptionStatus | string): string {
  const labels: Record<string, string> = { GRANTED: 'Verildi', REVOKED: 'Geri alındı', EXPIRED: 'Süresi doldu' };
  return labels[status] ?? status;
}

export function promoLotStatusLabel(status: PromoCreditLotStatus | string): string {
  const labels: Record<string, string> = { ACTIVE: 'Aktif', EXHAUSTED: 'Tükendi', EXPIRED: 'Süresi doldu', REVOKED: 'Geri alındı' };
  return labels[status] ?? status;
}

export function campaignEventStatusLabel(status: CampaignTriggerEventStatus | string): string {
  const labels: Record<string, string> = {
    PENDING: 'Bekliyor',
    PROCESSING: 'İşleniyor',
    EVALUATED: 'Değerlendirildi',
    SETTLED: 'Hak ediş verildi',
    RETRY_WAIT: 'Yeniden deneme bekliyor',
  };
  return labels[status] ?? status;
}

export function campaignRevokeReasonLabel(reason: string | null): string {
  if (reason === 'PAYMENT_REVERSED') return 'Ödeme iadesi';
  if (reason === 'ADMIN_REVOKED') return 'Yönetici kararı';
  return reason ?? '—';
}

/** Read-only view of the evaluation queue (S2B2 rev. 2); no screen acts on it. */
export type CampaignEvaluationQueue = {
  pending: number;
  processing: number;
  retryWait: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
};

export type CampaignListResponse = {
  /** Read from OperationsSettings, fail-closed; no admin screen writes it. */
  engineEnabled: boolean;
  evaluationQueue: CampaignEvaluationQueue;
  items: Array<Campaign & { currentVersion: CampaignVersionSummary | null; activeVersion: CampaignVersionSummary | null }>;
  nextCursor: string | null;
};

export type CampaignDetailResponse = {
  engineEnabled: boolean;
  evaluationQueue: CampaignEvaluationQueue;
  campaign: Campaign;
  currentVersion: CampaignVersion | null;
  activeVersion: CampaignVersion | null;
  /** CMP-006 PR-D: channel readiness of the stored and the running version, as the activation gate would judge now. */
  currentVersionChannel: CampaignChannelReadiness | null;
  activeVersionChannel: CampaignChannelReadiness | null;
  versions: CampaignVersion[];
  audit: CampaignAuditEntry[];
};

export type CampaignRuleError = { path: string; code: string; message: string };

export type CampaignValidationResponse = {
  valid: boolean;
  errors: CampaignRuleError[];
  summary: {
    trigger: string;
    factSetKey: string | null;
    eligibilityFacts: string[];
    conditionCount: number;
    benefitCredits: number;
    benefitExpiresInDays: number;
    /** CMP-006 PR-D. */
    channel?: string;
  } | null;
};

export function campaignStatusLabel(status: CampaignStatus | string): string {
  const labels: Record<string, string> = {
    DRAFT: 'Taslak',
    ACTIVE: 'Etkin',
    PAUSED: 'Duraklatıldı',
    ENDED: 'Sona erdi',
  };
  return labels[status] ?? status;
}

export function campaignStatusBadgeClass(status: CampaignStatus | string): string {
  switch (status) {
    case 'ACTIVE':
      return 'badge badge-good';
    case 'PAUSED':
      return 'badge badge-warn';
    case 'ENDED':
      return 'badge badge-muted';
    default:
      return 'badge badge-info';
  }
}

// ───────────────────────────── PR-0: admin roles ─────────────────────────────

/** One role as the panel lists it. */
export type AdminRoleSummary = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  permissions: AdminPermission[];
  activeAssignmentCount: number;
};

export type AdminRoleDetail = Omit<AdminRoleSummary, 'activeAssignmentCount'> & {
  assignments: {
    id: string;
    assignedAt: string;
    user: { id: string; name: string | null; email: string | null; role: UserRole; isActive: boolean };
  }[];
};

export type AdminUserRoles = {
  userId: string;
  role: UserRole;
  isSuperAdmin: boolean;
  assignments: {
    id: string;
    assignedAt: string;
    revokedAt: string | null;
    role: { id: string; key: string; name: string; isActive: boolean; permissions: AdminPermission[] };
  }[];
};

export function listAdminRoles() {
  return apiFetch<AdminRoleSummary[]>('/admin/roles');
}

export function getAdminRole(id: string) {
  return apiFetch<AdminRoleDetail>(`/admin/roles/${id}`);
}

export function listAdminPermissionCatalogue() {
  return apiFetch<{ permissions: AdminPermission[] }>('/admin/permissions');
}

export function listAdminUserRoles(userId: string) {
  return apiFetch<AdminUserRoles>(`/admin/users/${userId}/roles`);
}

/**
 * The Turkish label for one permission, built from its own name.
 *
 * A hand-written dictionary of 76 entries would drift the first time a
 * permission is added and nobody updates it; this derives the area and the verb
 * from the value itself, so a new permission reads sensibly on the day it
 * appears. The area names below are the only hand-written part, and a missing
 * one falls back to the raw prefix rather than to nothing.
 */
export function adminPermissionLabel(permission: AdminPermission): {
  area: string;
  action: string;
} {
  const AREAS: Record<string, string> = {
    DASHBOARD: 'Panel',
    CAMPAIGNS: 'Kampanya',
    CAMPAIGN: 'Kampanya',
    CATEGORIES: 'Kategori',
    QUESTIONS: 'Form soruları',
    COMPANY: 'Şirket ayarları',
    OPERATIONS: 'Operasyon ayarları',
    SCHEDULERS: 'Zamanlanmış işler',
    MARKETPLACE: 'Pazaryeri yayını',
    CREDIT: 'Kredi paketleri',
    CREDITS: 'Kredi bakiyesi',
    FINANCE: 'Finans',
    PACKAGE: 'Paket satın almaları',
    PAYMENTS: 'Ödeme yapılandırması',
    OFFERS: 'Teklifler',
    OFFER: 'Teklif iadeleri',
    REQUESTS: 'Talepler',
    REQUEST: 'Talep bildirimleri',
    CONTACT: 'İletişim paylaşımı',
    CUSTOMERS: 'Hizmet alanlar',
    CUSTOMER: 'Hizmet alan notları',
    PROVIDERS: 'Hizmet verenler',
    PROVIDER: 'Hizmet veren işlemleri',
    SHOWCASE: 'Vitrin',
    SUPPORT: 'Destek',
    NOTIFICATION: 'Bildirimler',
    UPLOADS: 'Yüklemeler',
    ADMIN: 'Admin hesapları',
  };
  const ACTIONS: Record<string, string> = {
    READ: 'okuma',
    WRITE: 'yazma',
    STATUS: 'durum değiştirme',
    DELETE: 'silme',
    MODERATE: 'moderasyon',
    DECIDE: 'karar verme',
    ISSUE: 'oluşturma',
    REVOKE: 'geri alma',
    RETRY: 'yeniden deneme',
    EXECUTE: 'toplu çalıştırma',
    CANCEL: 'iptal',
    TOGGLE: 'açma/kapama',
    GRANT: 'yükleme',
    DEDUCT: 'düşme',
    LIFECYCLE: 'yaşam döngüsü',
    RECALC: 'yeniden hesaplama',
    REOPEN: 'yeniden açma',
  };

  // CMP-006 PR-B: the refund queue is its own area, and its two write
  // permissions name roles in a maker-checker pair rather than verbs.
  const PACKAGE_REFUND: Record<string, string> = {
    PACKAGE_REFUND_READ: 'okuma',
    PACKAGE_REFUND_REQUEST_CREATE: 'talep açma ve işleme alma',
    PACKAGE_REFUND_APPROVE: 'onay, ret ve mutabakat kaydı',
  };
  if (PACKAGE_REFUND[permission]) {
    return { area: 'Paket iadeleri', action: PACKAGE_REFUND[permission] };
  }

  // CMP-006 PR-C: two permissions whose last word is not a verb.
  if (permission === 'PROVIDER_REGISTRATION_READ_SENSITIVE') {
    return { area: 'Hizmet verenler', action: 'işletme kayıt numarasının ham değerini görme (her görüntüleme kayıt altına alınır)' };
  }
  if (permission === 'PROMOTION_ELIGIBILITY_REVIEW') {
    return { area: 'Kampanya', action: 'promosyon uygunluk incelemesi ve kararı' };
  }

  const parts = permission.split('_');
  const area = AREAS[parts[0] ?? ''] ?? parts[0] ?? permission;
  const action = ACTIONS[parts[parts.length - 1] ?? ''] ?? permission;
  return { area, action };
}
