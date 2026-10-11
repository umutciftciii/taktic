import type { ServiceIssueReason } from './api';

/**
 * REL-002 Faz 4 — the provider's side of a service incident, as the API serves
 * it (`GET /providers/:providerId/incidents[/:incidentId]`).
 *
 * The API's projection is an allowlist: no customer name, phone, e-mail or
 * address, the customer's note already masked, no staff rationale and nothing
 * about the request's next round. These types carry exactly that and nothing
 * the screen could fill from anywhere else.
 */

export type ProviderIncidentStatus = 'REPORTED' | 'PROVIDER_RESPONDED' | 'CONFIRMED' | 'DISMISSED';
export type ProviderIncidentDecision = 'CONFIRMED' | 'DISMISSED';

export type ProviderIncident = {
  id: string;
  incidentNumber: string;
  offerId: string;
  status: ProviderIncidentStatus;
  reason: ServiceIssueReason;
  reportedAt: string;
  responseDueAt: string;
  /** Undecided, unanswered and past the window. A signal, never a lock. */
  responseOverdue: boolean;
  canRespond: boolean;
  respondedAt: string | null;
  request: { requestNumber: string | null; categoryName: string; city: string | null; district: string | null };
  outcome: { decision: ProviderIncidentDecision; decidedAt: string; corrected: boolean; message: string } | null;
};

export type ProviderIncidentDetail = ProviderIncident & {
  customerNote: string | null;
  promisedStartDate: string | null;
  promisedEndDate: string | null;
  providerResponse: string | null;
};

export type ProviderIncidentList = { items: ProviderIncident[] };

/** Mirrors the API's PROVIDER_RESPONSE_MIN_LENGTH / MAX_LENGTH. The API checks them again. */
export const INCIDENT_RESPONSE_MIN_LENGTH = 10;
export const INCIDENT_RESPONSE_MAX_LENGTH = 2000;

/** The locked status words — the same four on every panel. */
export const PROVIDER_INCIDENT_STATUS_LABELS: Record<ProviderIncidentStatus, string> = {
  REPORTED: 'Bildirildi',
  PROVIDER_RESPONDED: 'Hizmet veren yanıtladı',
  CONFIRMED: 'Doğrulandı',
  DISMISSED: 'Reddedildi',
};

export function providerIncidentStatusClass(status: ProviderIncidentStatus): string {
  switch (status) {
    case 'REPORTED':
      return 'tag tag-accent';
    case 'CONFIRMED':
      return 'tag tag-ink';
    default:
      return 'tag tag-neutral';
  }
}

/** The 72-hour window, worded as what it is: an expectation, not a deadline that closes the form. */
export const INCIDENT_RESPONSE_GUIDANCE =
  'Yanıtınızı 72 saat içinde iletmenizi bekliyoruz; süre geçse de karar verilene kadar yanıt verebilirsiniz.';

export const INCIDENT_OVERDUE_LABEL = 'Yanıt süresi geçti';

const RESPONSE_ERROR_MESSAGES: Record<string, string> = {
  INCIDENT_RESPONSE_TOO_SHORT: `Yanıtınız en az ${INCIDENT_RESPONSE_MIN_LENGTH} karakter olmalı.`,
  INCIDENT_RESPONSE_TOO_LONG: `Yanıtınız en fazla ${INCIDENT_RESPONSE_MAX_LENGTH} karakter olabilir.`,
  INCIDENT_RESPONSE_ALREADY_SUBMITTED: 'Bu bildirime yanıtınız zaten kayda geçti.',
  INCIDENT_ALREADY_ADJUDICATED: 'Bu bildirim için karar verildi; artık yanıt eklenemez.',
};

export const INCIDENT_RESPONSE_GENERIC_ERROR = 'Yanıtınız şu anda gönderilemedi. Lütfen tekrar deneyin.';

export function incidentResponseErrorMessage(code: string | null): string {
  return (code && RESPONSE_ERROR_MESSAGES[code]) || INCIDENT_RESPONSE_GENERIC_ERROR;
}

/** The notice after a 409: the page re-reads the incident and shows it read-only. */
export const INCIDENT_CONFLICT_MESSAGES: Record<string, string> = {
  responded: RESPONSE_ERROR_MESSAGES.INCIDENT_RESPONSE_ALREADY_SUBMITTED!,
  decided: RESPONSE_ERROR_MESSAGES.INCIDENT_ALREADY_ADJUDICATED!,
};
