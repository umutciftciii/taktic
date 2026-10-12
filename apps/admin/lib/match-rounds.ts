/**
 * REL-002 Faz 5 — the admin panel's view of a request's match rounds: the
 * response shapes of `GET /service-requests/:id/rounds` and
 * `GET /admin/service-requests/match-review`, the locked Turkish copy, and the
 * one rule that decides whether "Yeni tur aç" is offered.
 *
 * No import of `lib/api` (which reads cookies), so client components and the
 * pure label tests can use it.
 */

import type { ProviderIncidentStatus, ServiceIssueReason, IncidentDecision } from './service-incidents';

export type MatchRoundStatus = 'OPEN' | 'MATCHED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type MatchRoundSource = 'MARKETPLACE' | 'DIRECT_SHOWCASE';
export type MatchRoundOpenedBy = 'REQUEST_CREATED' | 'SERVICE_ISSUE' | 'ADMIN';

/** Mirrors `MAX_AUTO_MATCH_ROUNDS` (`limits.json maxAutoMatchRounds`): past it only staff open a round. */
export const MAX_AUTO_MATCH_ROUNDS = 3;

/** Mirrors the API's opening note rule (match-review.service.ts). */
export const ROUND_OPENING_NOTE_MIN_LENGTH = 10;
export const ROUND_OPENING_NOTE_MAX_LENGTH = 2000;

export const MATCH_ROUND_STATUS_LABELS: Record<MatchRoundStatus, string> = {
  OPEN: 'Teklife açık',
  MATCHED: 'Eşleşti',
  COMPLETED: 'Tamamlandı',
  CANCELLED: 'İptal edildi',
  EXPIRED: 'Süresi doldu',
  FAILED: 'Başarısız (hizmet aksaklığı)',
};

export const MATCH_ROUND_SOURCE_LABELS: Record<MatchRoundSource, string> = {
  MARKETPLACE: 'Pazar yeri',
  DIRECT_SHOWCASE: 'Vitrin (doğrudan)',
};

export const MATCH_ROUND_OPENED_BY_LABELS: Record<MatchRoundOpenedBy, string> = {
  REQUEST_CREATED: 'Talep oluşturuldu',
  SERVICE_ISSUE: 'Hizmet aksaklığı sonrası otomatik',
  ADMIN: 'Yönetici açtı',
};

/** Text for a round's status badge; the colour is never the only signal. */
export function matchRoundStatusLabel(status: string): string {
  return MATCH_ROUND_STATUS_LABELS[status as MatchRoundStatus] ?? status;
}

export function matchRoundStatusBadgeClass(status: string): string {
  switch (status) {
    case 'OPEN':
    case 'MATCHED':
      return 'badge badge-info';
    case 'COMPLETED':
      return 'badge badge-good';
    case 'FAILED':
      return 'badge badge-bad';
    default:
      return 'badge badge-muted';
  }
}

/** Shown on a matched round whose accepted offer promised no days (REL-002 decision 1). */
export const SCHEDULE_MISSING_NOTE = 'Taahhüt tarihi yok — otomatik sorun bildirimi kullanılamaz';

export type AdminRoundTimelineRound = {
  id: string;
  roundNumber: number;
  status: MatchRoundStatus;
  source: MatchRoundSource;
  openedBy: MatchRoundOpenedBy;
  openedAt: string;
  publishedAt: string | null;
  expiresAt: string | null;
  reminderSentAt: string | null;
  matchedAt: string | null;
  matchedOfferId: string | null;
  matchedProviderId: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  failedAt: string | null;
  isCurrent: boolean;
  offerCount: number;
  /** null when the round never had a winner. */
  winnerScheduleMissing: boolean | null;
  /** OFFERS_READ only — absent otherwise. */
  matchedProvider?: { id: string; businessName: string } | null;
  matchedOffer?: {
    id: string;
    offerNumber: string | null;
    estimatedStartDate: string | null;
    estimatedCompletionDate: string | null;
  } | null;
  failureIncident: {
    id: string;
    incidentNumber: string;
    providerId: string;
    offerId: string;
    reason: ServiceIssueReason;
    customerNote: string | null;
    status: ProviderIncidentStatus;
    reportedAt: string;
    effectiveDecision: IncidentDecision | null;
    corrected: boolean;
  } | null;
  thread: { id: string; mode: 'ACTIVE' | 'READ_ONLY' } | null;
  /** CONTACT_REVEAL_READ only — absent otherwise. */
  contactRevealed?: boolean;
  /** The staff opening that created this round (Round 4+). */
  opening: {
    id: string;
    fromRoundId: string;
    note: string;
    createdAt: string;
    openedBy: { id: string; name: string | null; email?: string | null };
  } | null;
};

export type AdminRoundTimeline = {
  requestId: string;
  requestStatus: string;
  currentRoundId: string;
  exclusions: Array<{ providerId: string; sourceRoundId: string; incidentId: string; reason: string; createdAt: string }>;
  rounds: AdminRoundTimelineRound[];
};

export type MatchReviewQueueItem = {
  id: string;
  requestNumber: string | null;
  city: string;
  district: string;
  submittedAt: string;
  category: { id: string; name: string };
  currentRound: {
    id: string;
    roundNumber: number;
    failedAt: string | null;
    failureIncident: {
      id: string;
      incidentNumber: string;
      status: ProviderIncidentStatus;
      reason: ServiceIssueReason;
      providerId: string;
      provider: { businessName: string };
    } | null;
  };
  exclusionCount: number;
  manualOpeningCount: number;
};

export type MatchReviewQueue = { total: number; items: MatchReviewQueueItem[] };

/**
 * Whether "Yeni tur aç" applies to this timeline at all (the permission is
 * checked separately): the request waits in MATCH_REVIEW on its current
 * round, that round FAILED, it is past the automatic limit, and no round is
 * live. The API re-checks every part in its own transaction.
 */
export function openNextRoundTarget(timeline: AdminRoundTimeline): AdminRoundTimelineRound | null {
  if (timeline.requestStatus !== 'MATCH_REVIEW') return null;
  const current = timeline.rounds.find((round) => round.id === timeline.currentRoundId) ?? null;
  if (!current || current.status !== 'FAILED' || current.roundNumber < MAX_AUTO_MATCH_ROUNDS) return null;
  if (timeline.rounds.some((round) => round.status === 'OPEN' || round.status === 'MATCHED')) return null;
  return current;
}

/** The refusal sentences for `?roundError=`, keyed by the API's stable code. */
export const OPEN_NEXT_ROUND_ERROR_MESSAGES: Record<string, string> = {
  confirmation:
    'Yeni tur açılmadı: onay penceresinden onay alınamadı. Sayfa tam yüklendikten sonra yeniden deneyin.',
  MATCH_REVIEW_NOTE_REQUIRED: `Yeni tur açmak için en az ${ROUND_OPENING_NOTE_MIN_LENGTH} karakterlik bir iç not yazın.`,
  MATCH_REVIEW_NOTE_TOO_LONG: `İç not en fazla ${ROUND_OPENING_NOTE_MAX_LENGTH} karakter olabilir.`,
  MATCH_REVIEW_ALREADY_REOPENED: 'Bu talep için yeni tur zaten açıldı; sayfa güncel hâliyle gösteriliyor.',
  REQUEST_NOT_IN_MATCH_REVIEW: 'Talep artık eşleşme incelemesinde değil; yeni tur açılmadı.',
  ROUND_CHANGED: 'Talebin güncel turu bu sayfa açıldıktan sonra değişti; yeni tur açılmadı.',
  MATCH_REVIEW_INCONSISTENT: 'Talebin tur kaydı tutarsız görünüyor; yeni tur açılmadı. Teknik ekibe bildirin.',
  IDEMPOTENCY_KEY_REUSED: 'Form süresi doldu; sayfayı yenileyip yeniden deneyin.',
  SUPER_ADMIN_REQUIRED: 'Yeni tur açmak yalnız süper yöneticiye açıktır.',
  CONCURRENT_MODIFICATION: 'Talep aynı anda değiştirildi; sayfayı yenileyip yeniden deneyin.',
  NOT_FOUND: 'Talep bulunamadı.',
  error: 'Yeni tur açılamadı. Lütfen tekrar deneyin.',
};

export function openNextRoundErrorMessage(code: string | undefined | null): string | null {
  if (!code) return null;
  return OPEN_NEXT_ROUND_ERROR_MESSAGES[code] ?? OPEN_NEXT_ROUND_ERROR_MESSAGES.error!;
}
