/**
 * REL-002 Faz 4 — the admin panel's view of service incidents and provider
 * reliability: the response shapes of `apps/api/src/modules/service-incidents`
 * and the locked Turkish copy for them.
 *
 * No import of `lib/api` (which reads cookies), so client components and the
 * pure label tests can use it.
 */

export type ProviderIncidentStatus = 'REPORTED' | 'PROVIDER_RESPONDED' | 'CONFIRMED' | 'DISMISSED';
export type IncidentDecision = 'CONFIRMED' | 'DISMISSED';
export type ReliabilityLevel = 'NORMAL' | 'WARNING' | 'ADMIN_REVIEW_REQUIRED';
export type ReliabilityReviewStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type ServiceIssueReason =
  | 'PROVIDER_NO_SHOW'
  | 'WORK_NOT_STARTED'
  | 'WORK_NOT_COMPLETED'
  | 'PROVIDER_STOPPED_WORK'
  | 'PROVIDER_CANCELLED_BEFORE_START'
  | 'OTHER';

export const PROVIDER_INCIDENT_STATUSES: ProviderIncidentStatus[] = [
  'REPORTED',
  'PROVIDER_RESPONDED',
  'CONFIRMED',
  'DISMISSED',
];

export const PROVIDER_INCIDENT_STATUS_LABELS: Record<ProviderIncidentStatus, string> = {
  REPORTED: 'Bildirildi',
  PROVIDER_RESPONDED: 'Hizmet veren yanıtladı',
  CONFIRMED: 'Doğrulandı',
  DISMISSED: 'Reddedildi',
};

export const INCIDENT_DECISION_LABELS: Record<IncidentDecision, string> = {
  CONFIRMED: 'Doğrulandı',
  DISMISSED: 'Reddedildi',
};

export const RELIABILITY_LEVELS: ReliabilityLevel[] = ['NORMAL', 'WARNING', 'ADMIN_REVIEW_REQUIRED'];

export const RELIABILITY_LEVEL_LABELS: Record<ReliabilityLevel, string> = {
  NORMAL: 'Normal',
  WARNING: 'Uyarı',
  ADMIN_REVIEW_REQUIRED: 'Yönetici incelemesi gerekli',
};

export const RELIABILITY_REVIEW_STATUS_LABELS: Record<ReliabilityReviewStatus, string> = {
  OPEN: 'Açık',
  ACKNOWLEDGED: 'Üstlenildi',
  RESOLVED: 'Sonuçlandı',
};

/** Mirrors `SERVICE_ISSUE_REASON_LABELS` (apps/api service-issue-eligibility.ts). */
export const SERVICE_ISSUE_REASONS: ServiceIssueReason[] = [
  'PROVIDER_NO_SHOW',
  'WORK_NOT_STARTED',
  'WORK_NOT_COMPLETED',
  'PROVIDER_STOPPED_WORK',
  'PROVIDER_CANCELLED_BEFORE_START',
  'OTHER',
];

export const SERVICE_ISSUE_REASON_LABELS: Record<ServiceIssueReason, string> = {
  PROVIDER_NO_SHOW: 'Hizmet veren gelmedi',
  WORK_NOT_STARTED: 'İş başlamadı',
  WORK_NOT_COMPLETED: 'İş tamamlanmadı',
  PROVIDER_STOPPED_WORK: 'Hizmet veren işi yarıda bıraktı',
  PROVIDER_CANCELLED_BEFORE_START: 'Hizmet veren işi yapamayacağını bildirdi',
  OTHER: 'Diğer',
};

export const ELIGIBILITY_BASIS_LABELS: Record<string, string> = {
  OFFER_DATES: 'Teklifteki tarihler geçti',
  PROVIDER_CANCELLATION: 'Hizmet veren işi yapamayacağını bildirdi',
};

export const MATCH_ROUND_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Açık',
  MATCHED: 'Eşleşti',
  COMPLETED: 'Tamamlandı',
  CANCELLED: 'İptal edildi',
  EXPIRED: 'Süresi doldu',
  FAILED: 'Aksaklıkla kapandı',
};

export const MATCH_ROUND_SOURCE_LABELS: Record<string, string> = {
  MARKETPLACE: 'Pazaryeri',
  DIRECT_SHOWCASE: 'Vitrin (doğrudan)',
};

export function incidentStatusBadgeClass(status: ProviderIncidentStatus | string): string {
  switch (status) {
    case 'CONFIRMED':
      return 'badge badge-bad';
    case 'DISMISSED':
      return 'badge badge-muted';
    case 'PROVIDER_RESPONDED':
      return 'badge badge-info';
    default:
      return 'badge badge-warn';
  }
}

export function reliabilityLevelBadgeClass(level: ReliabilityLevel | string): string {
  switch (level) {
    case 'ADMIN_REVIEW_REQUIRED':
      return 'badge badge-bad';
    case 'WARNING':
      return 'badge badge-warn';
    default:
      return 'badge badge-good';
  }
}

export function reviewStatusBadgeClass(status: ReliabilityReviewStatus | string): string {
  switch (status) {
    case 'OPEN':
      return 'badge badge-warn';
    case 'ACKNOWLEDGED':
      return 'badge badge-info';
    default:
      return 'badge badge-muted';
  }
}

/** The staff rationale and the review note: the API's RATIONALE_MIN/MAX_LENGTH. */
export const RATIONALE_MIN_LENGTH = 10;
export const RATIONALE_MAX_LENGTH = 2000;

/** The provider's response window (a signal, never a lock). */
export const PROVIDER_RESPONSE_SLA_HOURS = 72;

/** Whole hours left until `dueAt`, at least 1 while the window is open; 0 once it has passed. */
export function hoursLeft(dueAt: string, now: Date = new Date()): number {
  const ms = new Date(dueAt).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 3_600_000));
}

/** "%40", or "—" when there is nothing to divide. */
export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `%${Math.round(value * 100)}`;
}

/**
 * The sentence an operator reads for an API refusal on these screens, by the
 * API's stable `code` (service-incident.errors.ts). Unknown codes fall back to
 * the API's own (Turkish) message, then to a generic sentence.
 */
export const SERVICE_INCIDENT_ERROR_MESSAGES: Record<string, string> = {
  confirmation:
    'İşlem yapılmadı: onay penceresinden onay alınamadı. Sayfa tam yüklendikten sonra yeniden deneyin.',
  RATIONALE_REQUIRED: `En az ${RATIONALE_MIN_LENGTH} karakterlik bir gerekçe yazın.`,
  RATIONALE_TOO_LONG: `Gerekçe en fazla ${RATIONALE_MAX_LENGTH} karakter olabilir.`,
  INCIDENT_ALREADY_ADJUDICATED: 'Bu bildirim için karar zaten verildi; sayfayı yenileyin.',
  INCIDENT_NOT_ADJUDICATED: 'Bu bildirim için henüz karar verilmedi; düzeltilecek bir karar yok.',
  INCIDENT_ADJUDICATION_CHANGED: 'Karar bu sayfa açıldıktan sonra değişti; sayfayı yenileyin.',
  INCIDENT_CORRECTION_SAME_DECISION: 'Düzeltme, geçerli karardan farklı bir karar olmalı.',
  SUPER_ADMIN_REQUIRED: 'Karar düzeltmesini yalnız süper yönetici yapabilir.',
  RELIABILITY_REVIEW_ALREADY_RESOLVED: 'Bu inceleme zaten sonuçlandırıldı; sayfayı yenileyin.',
  RELIABILITY_REVIEW_ALREADY_ACKNOWLEDGED: 'Bu inceleme zaten üstlenildi; sayfayı yenileyin.',
  NOT_FOUND: 'Kayıt bulunamadı; sayfayı yenileyin.',
  error: 'İşlem tamamlanamadı. Lütfen tekrar deneyin.',
};

export function serviceIncidentErrorMessage(code: string | undefined | null): string | null {
  if (!code) return null;
  return SERVICE_INCIDENT_ERROR_MESSAGES[code] ?? SERVICE_INCIDENT_ERROR_MESSAGES.error!;
}

/** `{ code }` out of an API refusal body, when it has one. */
export function readApiErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

// ─────────────────────────── response shapes ───────────────────────────

export type ServiceIncidentListItem = {
  id: string;
  incidentNumber: string;
  status: ProviderIncidentStatus;
  reason: ServiceIssueReason;
  reasonLabel: string;
  reportedAt: string;
  responseDueAt: string;
  respondedAt: string | null;
  responseOverdue: boolean;
  lateResponse: boolean;
  roundNumber: number;
  provider: { id: string; businessName: string; confirmed90d: number; riskLevel: ReliabilityLevel };
  request: { id: string; requestNumber: string | null; categoryName: string };
  decision: { adjudicationId: string; decision: IncidentDecision; corrected: boolean; decidedAt: string } | null;
};

export type ServiceIncidentListResponse = {
  items: ServiceIncidentListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export type ReliabilityReview = {
  id: string;
  providerId: string;
  status: ReliabilityReviewStatus;
  openedAt: string;
  openedBySystem: boolean;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  note: string | null;
  triggerIncident: { id: string; incidentNumber: string } | null;
  acknowledgedBy: { id: string; name: string | null } | null;
  resolvedBy: { id: string; name: string | null } | null;
};

export type ProviderReliabilitySummary = {
  windowDays: number;
  windowStart: string;
  confirmed: number;
  dismissed: number;
  pending: number;
  total: number;
  responded: number;
  responseRate: number | null;
  lateResponses: number;
  overdueResponses: number;
  level: ReliabilityLevel;
  thresholds: { warningAt: number; reviewAt: number };
  openReview: ReliabilityReview | null;
};

export type IncidentAdjudication = {
  id: string;
  sequence: number;
  kind: 'INITIAL' | 'CORRECTION';
  decision: IncidentDecision;
  previousDecision: IncidentDecision | null;
  supersedesAdjudicationId: string | null;
  rationale: string;
  decidedAt: string;
  decidedBy: { id: string; name: string | null } | null;
  effective: boolean;
};

export type ServiceIncidentDetail = {
  id: string;
  incidentNumber: string;
  status: ProviderIncidentStatus;
  reason: ServiceIssueReason;
  reasonLabel: string;
  customerNote: string | null;
  reportedAt: string;
  eligibilityBasis: string;
  schedule: { promisedStartDate: string | null; promisedEndDate: string | null };
  response: {
    text: string | null;
    respondedAt: string | null;
    dueAt: string;
    overdue: boolean;
    late: boolean;
    windowOpen: boolean;
  };
  request: {
    id: string;
    requestNumber: string | null;
    status: string;
    categoryName: string;
    city: string;
    district: string;
    currentRound: { roundNumber: number; status: string } | null;
  };
  round: {
    id: string;
    roundNumber: number;
    status: string;
    source: string;
    matchedAt: string | null;
    failedAt: string | null;
  };
  offer: {
    id: string;
    status: string;
    priceAmount: number;
    estimatedStartDate: string | null;
    estimatedCompletionDate: string | null;
  };
  provider: { id: string; businessName: string; status: string };
  customer: { id: string; name: string | null };
  exclusion: { exists: boolean; createdAt: string | null };
  creditInvariant: 'NO_AUTOMATIC_REFUND';
  effective: {
    adjudicationId: string | null;
    decision: IncidentDecision | 'PENDING';
    kind: 'INITIAL' | 'CORRECTION' | null;
    sequence: number | null;
    decidedAt: string | null;
  };
  adjudications: IncidentAdjudication[];
  providerReliability: ProviderReliabilitySummary;
  customerReports: {
    windowDays: number;
    total: number;
    confirmed: number;
    dismissed: number;
    pending: number;
    dismissedRatio: number | null;
    signal: 'HIGH_DISMISSAL_RATIO' | null;
  };
};

export type ReliabilityQueueItem = {
  provider: { id: string; businessName: string | null; status: string | null };
  confirmed90d: number;
  level: ReliabilityLevel;
  review: ReliabilityReview | null;
};

export type ReliabilityQueueResponse = {
  items: ReliabilityQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export type ProviderReliabilityIncident = {
  id: string;
  incidentNumber: string;
  status: ProviderIncidentStatus;
  reason: ServiceIssueReason;
  reasonLabel: string;
  reportedAt: string;
  inWindow: boolean;
  responseDueAt: string;
  respondedAt: string | null;
  roundNumber: number;
  request: { id: string; requestNumber: string | null };
  adjudications: {
    id: string;
    sequence: number;
    kind: 'INITIAL' | 'CORRECTION';
    decision: IncidentDecision;
    createdAt: string;
    effective: boolean;
  }[];
};

export type ProviderReliabilityView = {
  provider: { id: string; businessName: string; status: string };
  summary: ProviderReliabilitySummary;
  incidents: ProviderReliabilityIncident[];
  reviews: ReliabilityReview[];
};

const RELIABILITY_DONE_MESSAGES: Record<string, string> = {
  acknowledged: 'İnceleme üstlenildi.',
  resolved: 'İnceleme sonuçlandırıldı. Hizmet verenin hesabında bir şey değişmedi.',
};

/** The `?reliability=` value a review action leaves behind: a done code or an error code. */
export function reliabilityNotice(value: string | undefined | null): { tone: 'success' | 'error'; text: string } | null {
  if (!value) return null;
  const done = RELIABILITY_DONE_MESSAGES[value];
  if (done) return { tone: 'success', text: done };
  return { tone: 'error', text: serviceIncidentErrorMessage(value)! };
}
