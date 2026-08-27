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

export type Question = {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  isRequired: boolean;
  options: QuestionOption[] | null;
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

export type Category = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl?: string | null;
  coverImageUrl?: string | null;
  iconKey?: CategoryIconKey | string | null;
  sortOrder: number;
  questions?: Question[];
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

export type RefundRecommendedAction = 'FULL_REFUND' | 'MANUAL_REVIEW' | 'NO_REFUND';

export type RefundEligibility = {
  eligible: boolean;
  recommendedAction: RefundRecommendedAction;
  reasonCode: string;
  reasonLabel: string;
  details: string;
  hoursSinceSubmitted: number | null;
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
  refundEligibility: RefundEligibility;
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
 * Loads matched contact details, returning null for every expected refusal.
 *
 * A 409 means the feature is off, a 404 that this request has no reveal, a 403
 * that this caller is not one of the two parties. None of those is an error the
 * screen should apologise for — the section simply does not appear.
 */
export async function getMatchedContactOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 409 || error.status === 404 || error.status === 403 || error.status === 401)
    ) {
      return null;
    }

    throw error;
  }
}

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
