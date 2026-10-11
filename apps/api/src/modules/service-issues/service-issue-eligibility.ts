import limits from '@taktic/shared/limits.json';
import { ServiceIssueEligibilityBasis, ServiceIssueReason } from '@prisma/client';
import { addIsoDays, compareIsoDays, IsoDay, todayIsoDay, toIsoDay } from '../../common/date-only';
import { detectContactDetails } from '../../common/contact-detection';

/**
 * REL-002 Faz 3 — when a customer may report a service issue, and with which
 * reason. Pure: the clock is the caller's server `now`, the days are the
 * accepted offer's own promises. Nothing here reads a client's date.
 *
 * Days are Europe/Istanbul calendar days. A promised day has *passed* only
 * once it is over: `today > promisedDay`. The provider may still turn up on
 * the evening of the day they promised, so "did not come" cannot be said on
 * that day itself.
 *
 * | today vs promised days     | NO_SHOW | NOT_STARTED | NOT_COMPLETED | STOPPED | OTHER | CANCELLED_BEFORE_START |
 * | today <= start             |   ✗     |     ✗       |      ✗        |   ✗     |  ✗    |          ✓             |
 * | start < today <= end       |   ✓     |     ✓       |      ✗        |   ✗     |  ✓    |          ✓             |
 * | today > end                |   ✓     |     ✓       |      ✓        |   ✓     |  ✓    |          ✓             |
 *
 * A match whose accepted offer does not carry both promised days (a legacy
 * offer from before Faz 2 made them required) cannot be reported here at
 * all — no reason, not even PROVIDER_CANCELLED_BEFORE_START. There is no
 * fallback date: such a customer is sent to support.
 */

/** Every reason, in the order the customer's form lists them. */
export const SERVICE_ISSUE_REASONS: readonly ServiceIssueReason[] = [
  ServiceIssueReason.PROVIDER_NO_SHOW,
  ServiceIssueReason.WORK_NOT_STARTED,
  ServiceIssueReason.WORK_NOT_COMPLETED,
  ServiceIssueReason.PROVIDER_STOPPED_WORK,
  ServiceIssueReason.PROVIDER_CANCELLED_BEFORE_START,
  ServiceIssueReason.OTHER,
];

/** The reasons that need a note: the customer's own account is the evidence. */
export const NOTE_REQUIRED_REASONS: ReadonlySet<ServiceIssueReason> = new Set([
  ServiceIssueReason.OTHER,
  ServiceIssueReason.PROVIDER_CANCELLED_BEFORE_START,
]);

export const SERVICE_ISSUE_NOTE_MIN_LENGTH: number = limits.serviceIssueNoteMinLength;
export const SERVICE_ISSUE_NOTE_MAX_LENGTH: number = limits.serviceIssueNoteMaxLength;

/** Which promised day a reason waits for, or none. */
type Gate = 'NONE' | 'START' | 'END';

const REASON_GATE: Record<ServiceIssueReason, Gate> = {
  PROVIDER_CANCELLED_BEFORE_START: 'NONE',
  PROVIDER_NO_SHOW: 'START',
  WORK_NOT_STARTED: 'START',
  OTHER: 'START',
  WORK_NOT_COMPLETED: 'END',
  PROVIDER_STOPPED_WORK: 'END',
};

export type PromisedSchedule = {
  start: Date | null;
  end: Date | null;
};

export type ReasonAvailability = {
  reason: ServiceIssueReason;
  available: boolean;
  /** The first Istanbul day this reason can be used, when it is not yet; else null. */
  opensOn: IsoDay | null;
};

export type ServiceIssueEligibility =
  | { supportOnly: true; reasons: ReasonAvailability[]; availableReasons: []; nextOpensOn: null }
  | {
      supportOnly: false;
      start: IsoDay;
      end: IsoDay;
      reasons: ReasonAvailability[];
      availableReasons: ServiceIssueReason[];
      /** The earliest day a reason that is not available yet opens; null when none is waiting. */
      nextOpensOn: IsoDay | null;
    };

/** The matrix above, evaluated at the server's `now`. */
export function evaluateServiceIssueEligibility(
  schedule: PromisedSchedule,
  now: Date,
): ServiceIssueEligibility {
  const start = schedule.start ? toIsoDay(schedule.start) : '';
  const end = schedule.end ? toIsoDay(schedule.end) : '';
  if (!start || !end) {
    return {
      supportOnly: true,
      reasons: SERVICE_ISSUE_REASONS.map((reason) => ({ reason, available: false, opensOn: null })),
      availableReasons: [],
      nextOpensOn: null,
    };
  }

  const today = todayIsoDay(now);
  const reasons = SERVICE_ISSUE_REASONS.map((reason): ReasonAvailability => {
    const gate = REASON_GATE[reason];
    if (gate === 'NONE') {
      return { reason, available: true, opensOn: null };
    }
    const promised = gate === 'START' ? start : end;
    const available = compareIsoDays(today, promised) > 0;
    return { reason, available, opensOn: available ? null : addIsoDays(promised, 1) };
  });

  const waiting = reasons
    .map((entry) => entry.opensOn)
    .filter((day): day is IsoDay => day !== null)
    .sort(compareIsoDays);

  return {
    supportOnly: false,
    start,
    end,
    reasons,
    availableReasons: reasons.filter((entry) => entry.available).map((entry) => entry.reason),
    nextOpensOn: waiting[0] ?? null,
  };
}

/** Which rule an accepted report rests on (written on the incident). */
export function eligibilityBasisFor(reason: ServiceIssueReason): ServiceIssueEligibilityBasis {
  return reason === ServiceIssueReason.PROVIDER_CANCELLED_BEFORE_START
    ? ServiceIssueEligibilityBasis.PROVIDER_CANCELLATION
    : ServiceIssueEligibilityBasis.OFFER_DATES;
}

/**
 * The note as it is stored: trimmed, every whitespace run collapsed to one
 * space, NULL when nothing is left. The same normalisation decides whether a
 * retried report is "the same payload".
 */
export function normalizeServiceIssueNote(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

const MASK = '[gizlendi]';
const MAX_MASKS = 20;

/**
 * The note as the provider may read it: anything that looks like a way to
 * reach somebody off the platform (phone, e-mail, link) is replaced. The
 * customer is not refused for writing one — their note is their account of
 * what happened, and staff read it raw.
 */
export function maskContactDetailsInNote(note: string | null): string | null {
  if (!note) {
    return note;
  }
  let masked = note;
  for (let i = 0; i < MAX_MASKS; i += 1) {
    const found = detectContactDetails(masked);
    if (!found || !found.match) {
      break;
    }
    const at = masked.indexOf(found.match);
    if (at < 0) {
      break;
    }
    masked = `${masked.slice(0, at)}${MASK}${masked.slice(at + found.match.length)}`;
  }
  return masked;
}

/** How each reason reads to a person (customer screen, mails, admin). */
export const SERVICE_ISSUE_REASON_LABELS: Record<ServiceIssueReason, string> = {
  PROVIDER_NO_SHOW: 'Hizmet veren gelmedi',
  WORK_NOT_STARTED: 'İş başlamadı',
  WORK_NOT_COMPLETED: 'İş tamamlanmadı',
  PROVIDER_STOPPED_WORK: 'Hizmet veren işi yarıda bıraktı',
  PROVIDER_CANCELLED_BEFORE_START: 'Hizmet veren işi yapamayacağını bildirdi',
  OTHER: 'Diğer',
};
