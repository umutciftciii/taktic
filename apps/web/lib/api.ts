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
    district: string;
    neighborhood: string | null;
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
    creditAmount: number;
    priceAmount: number;
    currency: string;
    isActive: boolean;
  };
};

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    SUBMITTED: 'Gönderildi',
    IN_REVIEW: 'İncelemede',
    APPROVED: 'Onaylandı',
    // The matching lifecycle states. Without these the fallback below rendered
    // the raw enum — a customer looking at their own accepted request saw
    // "MATCHED" in an otherwise Turkish screen.
    MATCHED: 'Eşleşti',
    COMPLETED: 'Tamamlandı',
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

export function urgencyLabel(urgency: string | null) {
  if (!urgency) return '-';
  const labels: Record<string, string> = {
    ASAP: 'En kısa zamanda',
    WITHIN_DAYS: 'Birkaç gün içinde',
    WITHIN_WEEKS: 'Birkaç hafta içinde',
    FLEXIBLE: 'Esnek',
    THIS_WEEK: 'Bu hafta',
    THIS_MONTH: 'Bu ay',
  };

  return labels[urgency] ?? urgency;
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

// Mirrors apps/admin/lib/api.ts#parseDecimalToMinor. Accepts user-entered decimal
// strings ("149.90", "149,90", "1500", numeric values) and returns the minor-unit
// integer (kuruş for TRY). Empty / invalid / negative values become null so optional
// form fields can preserve "no value". API DTOs still enforce @Min(100) for safety.
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

export function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return value;
  }
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

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
