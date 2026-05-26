const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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

export type Category = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  questions?: Question[];
};

export type ServiceRequest = {
  id: string;
  status: string;
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

export type ProviderProfile = {
  id: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string | null;
  city: string;
  district: string;
  addressNote: string | null;
  description: string | null;
  status: ProviderStatus;
  serviceCategories: ProviderServiceCategory[];
  serviceAreas: ProviderServiceArea[];
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
  creditRefundedAt: string | null;
  creditRefundReason: string | null;
  submittedAt: string;
};

export type ProviderRequestListItem = {
  id: string;
  category: {
    id: string;
    name: string;
    slug: string;
  };
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

export type ProviderOffer = {
  id: string;
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
  submittedAt: string;
  viewedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
  request: {
    id: string;
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

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `API request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}
