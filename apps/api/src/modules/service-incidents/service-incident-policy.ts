import { ProviderIncidentDecision } from '@prisma/client';

/**
 * REL-002 Faz 4 — the numbers the incident and reliability rules are made of,
 * in one place (REL-002 §33). Product decisions, not tuning knobs: changing
 * one is a decision about who is warned or reviewed, so each is a constant a
 * reviewer sees move in a diff.
 */

/** The provider's response window. A UX and risk signal only: nothing locks or decides when it ends. */
export const PROVIDER_RESPONSE_SLA_HOURS = 72;
export const PROVIDER_RESPONSE_SLA_MS = PROVIDER_RESPONSE_SLA_HOURS * 60 * 60 * 1000;

/** The rolling window the reliability level and the customer signal read, on `reportedAt` (server clock). */
export const RELIABILITY_WINDOW_DAYS = 90;
export const RELIABILITY_WINDOW_MS = RELIABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Effective CONFIRMED incidents in the window: 0–1 NORMAL, 2 WARNING, 3+ ADMIN_REVIEW_REQUIRED. */
export const RELIABILITY_WARNING_AT = 2;
export const RELIABILITY_REVIEW_AT = 3;

/**
 * The customer signal (admin-only, never a restriction): at least this many
 * *decided* reports in the window, of which at least this share dismissed.
 * Below the sample size no signal is given at all — two dismissals out of two
 * says nothing about a person.
 */
export const CUSTOMER_SIGNAL_MIN_DECIDED = 3;
export const CUSTOMER_SIGNAL_DISMISSED_RATIO = 0.6;

/** Staff rationale (both decisions, corrections) and a review's resolution note. */
export const RATIONALE_MIN_LENGTH = 10;
export const RATIONALE_MAX_LENGTH = 2000;

/** The provider's one response. */
export const PROVIDER_RESPONSE_MIN_LENGTH = 10;
export const PROVIDER_RESPONSE_MAX_LENGTH = 2000;

export type ReliabilityLevel = 'NORMAL' | 'WARNING' | 'ADMIN_REVIEW_REQUIRED';

export function reliabilityLevel(confirmedInWindow: number): ReliabilityLevel {
  if (confirmedInWindow >= RELIABILITY_REVIEW_AT) {
    return 'ADMIN_REVIEW_REQUIRED';
  }
  if (confirmedInWindow >= RELIABILITY_WARNING_AT) {
    return 'WARNING';
  }
  return 'NORMAL';
}

export type CustomerSignal = 'HIGH_DISMISSAL_RATIO';

export function customerSignal(counts: { confirmed: number; dismissed: number }): CustomerSignal | null {
  const decided = counts.confirmed + counts.dismissed;
  if (decided < CUSTOMER_SIGNAL_MIN_DECIDED) {
    return null;
  }
  return counts.dismissed / decided >= CUSTOMER_SIGNAL_DISMISSED_RATIO ? 'HIGH_DISMISSAL_RATIO' : null;
}

/** Trimmed, every whitespace run one space; null when nothing is left. */
export function normalizeIncidentText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

export function responseDueAt(reportedAt: Date): Date {
  return new Date(reportedAt.getTime() + PROVIDER_RESPONSE_SLA_MS);
}

export function windowStart(now: Date): Date {
  return new Date(now.getTime() - RELIABILITY_WINDOW_MS);
}

/**
 * What the provider is told about a decision — never the staff rationale, and
 * never the word "strike".
 */
export const PROVIDER_OUTCOME_COPY: Record<ProviderIncidentDecision, string> = {
  CONFIRMED: 'Bildirim incelendi ve doğrulandı; aksaklık hizmet kaydınıza işlendi.',
  DISMISSED: 'Bildirim incelendi ve reddedildi; hizmet kaydınıza işlenmedi.',
};
