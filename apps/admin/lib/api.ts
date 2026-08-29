import { urgencyLabel as sharedUrgencyLabel } from '@taktic/shared';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

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
  _count?: {
    questions: number;
    children?: number;
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
  };
};

export type ProviderServiceArea = {
  id: string;
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
  taxType: string | null;
  taxNumber: string | null;
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

export type OfferStatus =
  | 'SUBMITTED'
  | 'VIEWED'
  | 'SHORTLISTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'CANCELLED';

export type RefundRecommendedAction = 'FULL_REFUND' | 'MANUAL_REVIEW' | 'NO_REFUND';

export type RefundEligibility = {
  eligible: boolean;
  recommendedAction: RefundRecommendedAction;
  reasonCode: string;
  reasonLabel: string;
  details: string;
  hoursSinceSubmitted: number | null;
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
  reasonCode: 'NOT_VIEWED_48H';
  recommendedAction: 'FULL_REFUND';
};

export type RefundScanSkippedSummary = {
  alreadyRefunded: number;
  viewed: number;
  notOldEnough: number;
  noCreditSpend: number;
  statusNotEligible: number;
};

export type RefundScanResponse = {
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
  | 'ADJUSTMENT';

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
  role: 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER';
  isActive: boolean;
};

export type UserRole = 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER';

export const USER_ROLE_VALUES = ['SUPER_ADMIN', 'CUSTOMER', 'PROVIDER'] as const;

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
    CUSTOMER: 'Müşteri',
    PROVIDER: 'Hizmet Veren',
  };
  return labels[role] ?? role;
}

export function userRoleBadgeClass(role: UserRole): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'badge badge-warn';
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

export type FinanceSummaryRecentPurchase = {
  id: string;
  purchaseNumber: string | null;
  providerId: string;
  packageId: string;
  status: PackagePurchaseStatus;
  creditAmountSnapshot: number;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  packageNameSnapshot: string;
  mockPaymentReference: string | null;
  paidAt: string | null;
  createdAt: string;
  provider: {
    id: string;
    businessName: string;
  };
  package: {
    id: string;
    name: string;
  };
};

export const CREDIT_TRANSACTION_TYPES: CreditTransactionType[] = [
  'PACKAGE_PURCHASE',
  'OFFER_SPEND',
  'OFFER_REFUND',
  'ADMIN_GRANT',
  'ADMIN_DEDUCT',
  'ADJUSTMENT',
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
    FULL_REFUND: 'Tam iade önerilir',
    MANUAL_REVIEW: 'Manuel inceleme',
    NO_REFUND: 'İade yok',
  };

  return labels[action] ?? action;
}

export function refundActionBadgeClass(action: string) {
  switch (action) {
    case 'FULL_REFUND':
      return 'badge badge-good';
    case 'MANUAL_REVIEW':
      return 'badge badge-warn';
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

// Parses a user-provided decimal string ("149.90", "149,90", "  1500 ", "0",
// or numeric values) into a minor-unit integer. Returns null when the input is
// empty / whitespace / non-finite so optional form fields can preserve "no value".
// Negative inputs are also rejected (returned as null). Invalid inputs do not throw;
// callers should rely on API-side validation (DTO @Min(100)) for final enforcement.
export function parseDecimalToMinor(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    raw = String(value);
  } else {
    raw = value.trim();
    if (!raw) return null;
  }

  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const major = Number(normalized);
  if (!Number.isFinite(major) || major < 0) {
    return null;
  }

  return Math.round(major * 100);
}

// Renders a minor-unit integer as a "x.xx" string suitable for a controlled
// decimal <input>. Null/undefined become an empty string so optional form fields
// stay empty by default.
export function formatMinorAsInput(amountMinor: number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) {
    return '';
  }
  if (!Number.isFinite(amountMinor)) {
    return '';
  }
  return (amountMinor / 100).toFixed(2);
}

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
export { formatDate, formatDateTime, formatTime } from '@taktic/shared';

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
    if (response.status === 401 || response.status === 403) {
      redirect('/login');
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

export async function requireAdmin() {
  const user = await apiFetch<AuthUser>('/auth/me');
  if (user.role !== 'SUPER_ADMIN') {
    redirect('/login');
  }

  return user;
}
