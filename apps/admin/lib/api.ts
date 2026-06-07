import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

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

export type Category = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  coverImageUrl: string | null;
  iconKey: CategoryIconKey | string | null;
  isActive: boolean;
  sortOrder: number;
  _count?: {
    questions: number;
  };
  questions?: Question[];
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

export type Question = {
  id: string;
  categoryId: string;
  key: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  isRequired: boolean;
  options: QuestionOption[] | null;
  sortOrder: number;
  isActive: boolean;
};

export type ServiceRequestStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

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
  serviceCategories: ProviderServiceCategory[];
  serviceAreas: ProviderServiceArea[];
  creditBalance?: number;
  activeOffersCount?: number;
  totalOffersCount?: number;
  packagePurchasesCount?: number;
  recentOffers?: ProviderRecentOffer[];
  recentPackagePurchases?: ProviderRecentPackagePurchase[];
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
    creditAmount: number;
    priceAmount: number;
    currency: string;
    isActive: boolean;
  };
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
    REJECTED: 'Reddedildi',
    CANCELLED: 'İptal Edildi',
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

    const body = await response.text();
    throw new Error(body || `API request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function requireAdmin() {
  const user = await apiFetch<AuthUser>('/auth/me');
  if (user.role !== 'SUPER_ADMIN') {
    redirect('/login');
  }

  return user;
}
