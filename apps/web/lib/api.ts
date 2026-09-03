export * from './formatters';

import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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
 * The request column a question is bound to, when it is bound to one.
 *
 * A bound question is not rendered as its own input: it renames the built-in
 * field it names, and can make it mandatory for this category. The answer stays
 * in the column the rest of the product already reads.
 */
export type QuestionSystemField = 'ADDRESS' | 'BUDGET' | 'DESCRIPTION' | 'PREFERRED_DATE';

/**
 * How a condition compares the expected values against the answer.
 *
 * ANY — at least one of them was chosen. ALL — every one of them was. They
 * differ only for a multi-select source; the API refuses ALL anywhere else.
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
  key: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  isRequired: boolean;
  options: QuestionOption[] | null;
  systemField?: QuestionSystemField | null;
  isRouter?: boolean;
  conditions?: QuestionCondition[];
  routerRules?: QuestionRouterRule[];
  sortOrder: number;
};

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

export type CategoryKind = 'GROUP' | 'LEAF' | 'ROUTER';

export type Category = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl?: string | null;
  coverImageUrl?: string | null;
  iconKey?: CategoryIconKey | string | null;
  /**
   * LEAF for every category the public catalogue lists. A ROUTER is reachable
   * by slug — it is the question that decides which leaf the customer meant —
   * and is never listed.
   */
  kind?: CategoryKind;
  sortOrder: number;
  questions?: Question[];
};

/** One step of a routed flow, as the customer's browser carries it. */
export type RouterSelection = {
  questionKey: string;
  optionKey: string;
};

/** What POST /categories/routing/resolve answers. */
export type RoutingResolution = {
  entryCategorySlug: string;
  categorySlug: string;
  categoryName: string;
  kind: CategoryKind;
  pendingRouterQuestionKey: string | null;
  isFinal: boolean;
};

export type ServiceRequest = {
  id: string;
  status: string;
};

export type AuthUser = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER';
  isActive: boolean;
};

export type CustomerServiceRequest = {
  id: string;
  requestNumber: string | null;
  status: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  city: string;
  district: string;
  qualityScore: number;
  qualityLabel: RequestQualityLabel;
  /** null until the customer proves control of customerPhone with a one-time code. */
  phoneVerifiedAt: string | null;
  /** Set by the expiry scheduler when the request's 14-day window ran out. */
  expiredAt: string | null;
  submittedAt: string;
  offersCount: number;
  category: {
    id: string;
    name: string;
    slug: string;
  };
};

export type ProviderStatus = 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

/**
 * A service as the application form offers it.
 *
 * Narrower than `Category` on purpose, and served by its own endpoint: it says
 * what a business needs to pick a service and nothing about how ready that
 * service is, which is the operator's question and stays on their panel.
 */
export type ProviderEnrollmentCategory = {
  id: string;
  name: string;
  slug: string;
  iconKey: string | null;
  imageUrl: string | null;
  parent: { id: string; name: string; slug: string } | null;
  /** LIVE takes requests today; UPCOMING has not been released yet. */
  availability: 'LIVE' | 'UPCOMING';
};

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

/**
 * `GET /providers/:id` narrows its payload by viewer: anonymous and unrelated
 * callers get the public business card only. Everything the API strips from the
 * public projection is optional here, and `visibility` says which shape arrived.
 */
export type ProviderVisibility = 'public' | 'owner' | 'admin';

export type ProviderProfile = {
  id: string;
  userId?: string | null;
  /** Set only when a guest application was claimed; that is what freezes the
   * contact address. A profile a provider created for themselves has none. */
  claimedAt?: string | null;
  visibility?: ProviderVisibility;
  businessName: string;
  contactName?: string;
  phone?: string;
  email?: string | null;
  rejectionReason?: string | null;
  suspendedAt?: string | null;
  city: string;
  district: string;
  addressNote?: string | null;
  description: string | null;
  status: ProviderStatus;
  user?: {
    id: string;
    email: string | null;
    phone: string | null;
    name: string | null;
    role: 'SUPER_ADMIN' | 'CUSTOMER' | 'PROVIDER';
  } | null;
  serviceCategories: ProviderServiceCategory[];
  /**
   * Unreleased services this provider has joined — present on their own view
   * and the operator's, and on nobody else's. Absent from the public shape
   * entirely, which is why it is optional here.
   */
  upcomingServiceCategories?: ProviderServiceCategory[];
  serviceAreas: ProviderServiceArea[];
};

export type ProviderDashboard = {
  provider: ProviderProfile | null;
  creditBalance?: number;
  activeOffersCount?: number;
  recentOffersCount?: number;
  matchingApprovedRequestsCount?: number;
};

export type RequestQualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';

export type RequestQualityBreakdownComponent = {
  points: number;
  max: number;
  passed: boolean;
};

export type ProviderRequestAnswer = {
  id: string;
  questionKey: string;
  questionLabel: string;
  questionType: string;
  value: unknown;
  createdAt: string;
};

export type ExistingOfferSummary = {
  id: string;
  status: OfferStatus;
  priceAmount: number;
  creditCost: number;
  creditSpentTransactionId: string | null;
  creditRefundedTransactionId: string | null;
  creditRefundedAt: string | null;
  creditRefundReason: string | null;
  refundEligibility: RefundEligibility;
  submittedAt: string;
};

/** Why an otherwise matching request cannot be offered on. */
export type OfferBlockedReason = 'CATEGORY_INACTIVE' | 'CATEGORY_PRICE_UNSET';

export type ProviderRequestListItem = {
  id: string;
  category: {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    offerCreditCost: number | null;
  };
  /**
   * Credits this offer would cost, taken from the request's category. `null`
   * exactly when `canOffer` is false, and `offerBlockedReason` says why.
   */
  offerCreditCost: number | null;
  canOffer: boolean;
  offerBlockedReason: OfferBlockedReason | null;
  city: string;
  district: string;
  neighborhood: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  preferredDate: string | null;
  urgency: string | null;
  qualityScore: number;
  qualityLabel: RequestQualityLabel;
  submittedAt: string;
  createdAt: string;
  answersCount: number;
};

export type ProviderRequestDetail = Omit<ProviderRequestListItem, 'answersCount'> & {
  addressNote: string | null;
  description: string | null;
  qualityScoreBreakdown: Record<string, RequestQualityBreakdownComponent> | null;
  existingOffer: ExistingOfferSummary | null;
  providerCreditBalance?: number;
  answers: ProviderRequestAnswer[];
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

/**
 * Where an offer stands under the 48-hour unviewed-offer refund rule.
 *
 * `null` — on `policyStatus` — is not a fourth state. It means the offer was
 * submitted before the rule shipped, and the panel renders no policy state at
 * all for it rather than inventing one.
 */
export type UnviewedRefundPolicyStatus = 'AWAITING_VIEW' | 'VIEWED' | 'REFUNDED';

export type RefundEligibility = {
  eligible: boolean;
  recommendedAction: RefundRecommendedAction;
  reasonCode: string;
  reasonLabel: string;
  details: string;
  hoursSinceSubmitted: number | null;
  unviewedRefundPolicy: boolean;
  policyStatus: UnviewedRefundPolicyStatus | null;
  policyStatusLabel: string | null;
};

export type ProviderOffer = {
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
  request: {
    id: string;
    requestNumber: string | null;
    city: string;
    /** City and district only — see providerOfferInclude on the API side. */
    district: string;
    budgetMin: number | null;
    budgetMax: number | null;
    preferredDate: string | null;
    urgency: string | null;
    qualityScore: number;
    status: string;
    category: {
      id: string;
      name: string;
      slug: string;
    };
  };
  /**
   * The brief, served by the offer-detail route and only for an offer the API
   * itself sees as ACCEPTED. Null for every other status, and absent from the
   * offers list entirely — hence optional, and never a source the screen has
   * to gate on its own. It carries no contact detail and no street-level location: who the
   * customer is and how to reach them stays with the contact-sharing flow.
   */
  acceptedWorkScope?: ProviderAcceptedWorkScope | null;
};

export type ProviderAcceptedWorkScope = {
  description: string | null;
  requiredAnswers: Array<{
    questionKey: string;
    questionLabel: string;
    questionType: string;
    value: unknown;
  }>;
};

export type RequestOfferPreview = {
  id: string;
  offerNumber: string | null;
  provider: {
    businessName: string;
    city: string;
    district: string;
  };
  status: OfferStatus;
  priceAmount: number;
  currency: string;
  estimatedStartDate: string | null;
  estimatedCompletionDate: string | null;
  message: string;
  warrantyNote: string | null;
  creditCost: number;
  creditRefundedAt: string | null;
  creditRefundReason: string | null;
  submittedAt: string;
};

export type RequestOfferDetail = RequestOfferPreview & {
  requestId: string;
  viewedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
};

/**
 * Whether contact sharing is on, and which text the request form must link to.
 * Comes from the API so the flag has exactly one source of truth; carries no
 * personal data.
 */
export type ContactDisclosureConfig = {
  enabled: boolean;
  disclosureUrl: string | null;
  disclosureVersion: string | null;
};

/**
 * The details a matched party may see about the other one. These only ever
 * arrive from the dedicated matched-contact routes — no offer projection
 * carries them, before or after the match.
 */
export type MatchedProviderContact = {
  requestId: string;
  offerId: string;
  revealedAt: string;
  disclosureVersion: string;
  provider: {
    id: string;
    businessName: string;
    contactName: string;
    phone: string;
    email: string | null;
    city: string;
    district: string;
  };
};

export type MatchedCustomerContact = {
  requestId: string;
  offerId: string;
  revealedAt: string;
  disclosureVersion: string;
  customer: {
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
  };
};

/**
 * Reads the disclosure config, treating any failure as "off".
 *
 * A form that cannot reach the API must not render an acknowledgement it cannot
 * describe — and with the feature off there is nothing to show anyway.
 */
export async function getContactDisclosure(): Promise<ContactDisclosureConfig> {
  try {
    return await apiFetch<ContactDisclosureConfig>('/contact-sharing/disclosure');
  } catch {
    return { enabled: false, disclosureUrl: null, disclosureVersion: null };
  }
}

/**
 * Why a matched party cannot be shown the other side's details right now.
 *
 * A closed set, and each member is a different sentence on screen. Collapsing
 * them into "no data" is what made a failed match look like an empty one: the
 * customer had accepted an offer, the platform had told them the match was
 * complete, and the section that was supposed to carry the phone number simply
 * was not rendered — with nothing anywhere saying why.
 */
export type MatchedContactUnavailableReason =
  /** The deployment has contact sharing switched off. */
  | 'sharing-off'
  /** Matched, but no reveal is on record — the match predates the sharing. */
  | 'not-recorded'
  /** The API could not be reached, or answered in a way this screen cannot use. */
  | 'unreachable';

export type MatchedContactResult<T> =
  | { state: 'ready'; contact: T }
  /** The viewer is not one of the two parties. Nothing is rendered, by design. */
  | { state: 'hidden' }
  | { state: 'unavailable'; reason: MatchedContactUnavailableReason };

/**
 * Loads matched contact details, and says which kind of "no" it got.
 *
 * 403 and 401 stay silent: the caller is not a party to this match, and a
 * screen that explained itself there would be telling a stranger that a match
 * exists. Everything else is a state a party is entitled to an explanation
 * for — the screens above decide whether the viewer is one.
 */
export async function loadMatchedContact<T>(path: string): Promise<MatchedContactResult<T>> {
  try {
    return { state: 'ready', contact: await apiFetch<T>(path) };
  } catch (error) {
    if (!(error instanceof ApiError)) {
      return { state: 'unavailable', reason: 'unreachable' };
    }

    if (error.status === 403 || error.status === 401) {
      return { state: 'hidden' };
    }

    if (error.status === 409) {
      return { state: 'unavailable', reason: 'sharing-off' };
    }

    if (error.status === 404) {
      return { state: 'unavailable', reason: 'not-recorded' };
    }

    return { state: 'unavailable', reason: 'unreachable' };
  }
}

/**
 * What to tell a matched party when the details cannot be shown.
 *
 * Says what happened and what to do, and nothing about the other party — these
 * render on a screen that was supposed to be carrying a phone number, so the
 * one thing they must not do is leak a fragment of it.
 */
export const MATCHED_CONTACT_UNAVAILABLE_MESSAGES: Record<
  MatchedContactUnavailableReason,
  string
> = {
  'sharing-off':
    'İletişim bilgisi paylaşımı bu kurulumda kapalı olduğu için karşı tarafın bilgileri gösterilemiyor. Eşleşmeniz geçerlidir; destek ekibiyle iletişime geçebilirsiniz.',
  'not-recorded':
    'Bu eşleşme için iletişim paylaşımı kaydı bulunmuyor, bu yüzden bilgiler gösterilemiyor. Eşleşmeniz geçerlidir; destek ekibiyle iletişime geçebilirsiniz.',
  unreachable:
    'İletişim bilgileri şu anda yüklenemedi. Eşleşmeniz duruyor; lütfen sayfayı yenileyin, sorun sürerse destek ekibiyle iletişime geçin.',
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
};

/** What an offer package sells. */
export type OfferPackageType = 'ONE_TIME_CREDITS' | 'MONTHLY_QUOTA' | 'CATEGORY_UNLIMITED';

export type ProviderEntitlementStatus = 'ACTIVE' | 'EXPIRED' | 'PAST_DUE' | 'CANCELLED';

export type EntitlementRenewalFailureCode =
  | 'PROVIDER_UNSUPPORTED'
  | 'PAYMENT_METHOD_MISSING'
  | 'PAYMENT_DECLINED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'AUTO_RENEW_DISABLED'
  | 'ENTITLEMENT_NOT_RENEWABLE';

export type EntitlementScopeEntry = {
  categoryId: string;
  name: string;
  kind: 'GROUP' | 'LEAF' | 'ROUTER';
};

/**
 * One 30-day period the provider bought.
 *
 * Deliberately carries no payment credential: the API never selects the stored
 * payment-method reference into any response, and the admin view reports only
 * whether one exists.
 */
export type ProviderEntitlement = {
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
  /** Inside its own clock and ACTIVE — the only state that pays for offers. */
  usable: boolean;
  /** Paid for, but not started yet: an early renewal waiting its turn. */
  queued: boolean;
  quotaTotal: number | null;
  quotaRemaining: number | null;
  dailyOfferLimit: number | null;
  dailyOfferUsed: number | null;
  scope: EntitlementScopeEntry[];
  autoRenewEnabled: boolean;
  autoRenewConsentAt: string | null;
  cancelledAt: string | null;
  lastRenewalAttemptAt: string | null;
  lastRenewalFailureCode: EntitlementRenewalFailureCode | null;
  periodIndex: number;
  createdAt: string;
};

/**
 * Whether automatic renewal can be offered at all.
 *
 * Read from the bound payment adapter, not from configuration. When
 * `available` is false the screens say so as a fact and offer manual renewal —
 * there is no disabled switch and no "coming soon".
 */
export type AutoRenewCapability = {
  available: boolean;
  unsupportedReason: 'NO_STORED_PAYMENT_METHOD' | 'NO_LIVE_MODE' | null;
  message: string | null;
  periodDays: number;
};

export type ProviderEntitlements = {
  providerId: string;
  autoRenew: AutoRenewCapability;
  entitlements: ProviderEntitlement[];
};

export type OfferPackageScopeEntry = {
  categoryId: string;
  name: string;
  kind: 'GROUP' | 'LEAF' | 'ROUTER';
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
};

export type PurchasableOfferPackage = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: OfferPackageType;
  priceAmount: number;
  currency: string;
  creditAmount: number;
  quotaCredits: number | null;
  periodDays: number | null;
  dailyOfferLimit: number | null;
  scope: OfferPackageScopeEntry[];
  purchasable: boolean;
  unavailableCode: string | null;
  unavailableReason: string | null;
};

export type OfferPackageCatalogue = {
  providerId: string;
  periodDays: number;
  packages: PurchasableOfferPackage[];
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
};

export type ProviderCredits = {
  providerId: string;
  balance: number;
  transactions: ProviderCreditTransaction[];
};

/**
 * Which payment adapter the API is wired to.
 *
 * `mock` renders the in-app, clearly-labelled test checkout this application
 * has always had. `lemon-squeezy-test` opens a Lemon Squeezy **sandbox** hosted
 * page. Neither collects real money, and there is no live value: live payment
 * collection is not part of this build.
 */
export type PaymentProviderKind = 'mock' | 'lemon-squeezy-test';

export type PaymentMode = {
  provider: PaymentProviderKind;
  mode: 'test';
  liveEnabled: false;
};

export type AdminPaymentConfig = PaymentMode & {
  configurableKeys: string[];
  /** Names of unfilled settings. The API never returns their values. */
  missingConfig: string[];
  ready: boolean;
};

/**
 * What starting a checkout returns.
 *
 * `checkout.url` is null when the provider has no hosted page — the mock
 * adapter — and the web app renders its own checkout screen instead. Nothing in
 * this response loads credits: the purchase stays PENDING until a
 * signature-verified webhook says otherwise.
 */
export type CheckoutSessionResponse = {
  purchase: PackagePurchase;
  checkout: {
    provider: PaymentProviderKind;
    mode: 'test';
    url: string | null;
    expiresAt: string | null;
    reused: boolean;
  };
};

export type PackagePurchaseStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';

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
  providerCheckoutUrl: string | null;
  providerCheckoutExpiresAt: string | null;
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
  provider?: {
    id: string;
    businessName: string;
    contactName: string;
    email: string | null;
    city: string;
    district: string;
    status: ProviderStatus;
  };
  package?: {
    id: string;
    name: string;
    slug?: string;
    creditAmount: number;
    priceAmount: number;
    currency: string;
    isActive: boolean;
  };
};

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
    throw new ApiError(response.status, await response.text());
  }

  return response.json() as Promise<T>;
}

/**
 * Runs a fetch and turns "not found" (and, for detail screens, "not yours")
 * into a proper 404 page rather than an error boundary.
 *
 * 403 is in the list on purpose. A signed-in customer who opens somebody else's
 * request, or a provider who opens a request outside its categories, is not
 * having an accident the error boundary should apologise for — and confirming
 * "this exists, you just may not see it" is more than they should learn. The
 * 404 copy already says both things: the record may be gone, or it may not be
 * yours.
 */
export async function fetchOrNotFound<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 403 || error.status === 400)
    ) {
      notFound();
    }

    throw error;
  }
}

export async function getCurrentUser() {
  try {
    return await apiFetch<AuthUser>('/auth/me');
  } catch {
    return null;
  }
}

/* ── Post-match messaging ──────────────────────────────────────────────────
 *
 * Everything below describes what the API actually returns to one of the two
 * matched parties. It is deliberately narrow: a counterpart's display name, the
 * job the conversation belongs to, and message bodies. No telephone number, no
 * e-mail address, no address note or neighbourhood, no credit or payment fact,
 * and nothing at all about a competing offer — those live behind the
 * matched-contact routes and stay there.
 */

export type MessageSenderRole = 'CUSTOMER' | 'PROVIDER';

export type ThreadMessage = {
  id: string;
  threadId: string;
  senderUserId: string;
  senderRole: MessageSenderRole;
  body: string;
  createdAt: string;
  /** Opaque paging position. Only ever handed back to the API. */
  cursor: string;
};

export type MessageThreadSummary = {
  id: string;
  requestId: string;
  offerId: string;
  /** Which side of this conversation the signed-in person is. */
  viewerRole: MessageSenderRole;
  counterpart: { name: string };
  request: {
    id: string;
    requestNumber: string | null;
    city: string;
    district: string;
    category: { id: string; name: string; slug: string };
  };
  lastMessageAt: string | null;
  /** Whether the other party has seen everything in the thread. */
  counterpartHasRead: boolean;
  createdAt: string;
};

export type MessageThreadListEntry = MessageThreadSummary & {
  unreadCount: number;
  lastMessage: ThreadMessage | null;
};

export type MessageThreadDetail = MessageThreadSummary & {
  unreadCount: number;
  messages: ThreadMessage[];
  hasMoreBefore: boolean;
  olderCursor: string | null;
  latestCursor: string | null;
};

export type MessagePage = {
  messages: ThreadMessage[];
  hasMoreBefore: boolean;
  olderCursor: string | null;
  latestCursor: string | null;
};

export type MessageUnreadCount = {
  total: number;
  threads: number;
};

/**
 * Why a matched party has no conversation to open.
 *
 * A closed set, and each member is a different sentence on screen. It mirrors
 * MatchedContactUnavailableReason above and exists for the same reason: a match
 * that cannot carry a message screen must say so, rather than rendering an
 * empty one that reads as "nobody has written yet".
 */
export type ThreadUnavailableReason =
  | 'sharing-off'
  | 'not-recorded'
  | 'customer-not-registered'
  | 'provider-not-registered';

export const THREAD_UNAVAILABLE_MESSAGES: Record<ThreadUnavailableReason, string> = {
  'sharing-off':
    'İletişim paylaşımı bu kurulumda kapalı olduğu için mesajlaşma açılamıyor. Eşleşmeniz geçerlidir; destek ekibiyle iletişime geçebilirsiniz.',
  'not-recorded':
    'Bu eşleşme için iletişim paylaşımı kaydı bulunmuyor, bu yüzden mesajlaşma açılamıyor. Eşleşmeniz geçerlidir; destek ekibiyle iletişime geçebilirsiniz.',
  'customer-not-registered':
    'Bu talep bir kullanıcı hesabına bağlı olmadığı için mesajlaşma açılamıyor. Müşteriye iletişim bilgilerinden ulaşabilirsiniz.',
  'provider-not-registered':
    'Hizmet verenin işletme profili henüz bir hesaba bağlı olmadığı için mesajlaşma açılamıyor. İletişim bilgilerinden ulaşabilirsiniz.',
};

/**
 * The unread badge, or null when it could not be read.
 *
 * Null is not zero and is never rendered as one: a badge that says "0" because
 * the API was unreachable tells somebody there is nothing waiting for them when
 * there may well be. The sidebars render a dash instead.
 */
export async function loadUnreadMessageCount(): Promise<MessageUnreadCount | null> {
  try {
    return await apiFetch<MessageUnreadCount>('/messages/unread-count');
  } catch {
    return null;
  }
}

export type ResolveThreadResult =
  | { state: 'ready'; thread: MessageThreadSummary }
  /** The viewer is not a party to this match. Nothing is rendered, by design. */
  | { state: 'hidden' }
  | { state: 'unavailable'; reason: ThreadUnavailableReason }
  | { state: 'error' };

/**
 * Opens the conversation for a match, and says which kind of "no" it got.
 *
 * 404 and 403 stay silent for the same reason the matched-contact loader's do:
 * the caller is not one of the two parties, and a screen that explained itself
 * there would be telling a stranger that a match exists.
 */
export async function resolveMessageThread(requestId: string): Promise<ResolveThreadResult> {
  try {
    const thread = await apiFetch<MessageThreadSummary>('/messages/threads/resolve', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
    return { state: 'ready', thread };
  } catch (error) {
    if (!(error instanceof ApiError)) {
      return { state: 'error' };
    }

    if (error.status === 404 || error.status === 403 || error.status === 401) {
      return { state: 'hidden' };
    }

    if (error.status === 409) {
      const reason = readThreadUnavailableReason(error.body);
      return reason ? { state: 'unavailable', reason } : { state: 'error' };
    }

    return { state: 'error' };
  }
}

function readThreadUnavailableReason(body: string): ThreadUnavailableReason | null {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    const reason = parsed?.reason;
    return typeof reason === 'string' && reason in THREAD_UNAVAILABLE_MESSAGES
      ? (reason as ThreadUnavailableReason)
      : null;
  } catch {
    return null;
  }
}
