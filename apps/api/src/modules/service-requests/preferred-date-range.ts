import { BadRequestException } from '@nestjs/common';
import {
  compareIsoDays,
  endOfWeekIsoDay,
  isIsoDay,
  isoDayToStoredDate,
  todayIsoDay,
} from '../../common/date-only';

/**
 * The customer's preferred date range, made into two stored instants — or
 * refused.
 *
 * ## The rule
 *
 * A range is two calendar days in Europe/Istanbul, written as `YYYY-MM-DD`.
 * Both empty is legal for every urgency: it is what every request created
 * before the range existed carries, what "Esnek" means, and what a client that
 * predates the second field still sends. Given at all, the range has to be
 * whole (both ends), real (a day that exists, in the one format), not in the
 * past, in order, and consistent with the urgency the customer chose beside it:
 *
 * - `TODAY` — both ends are today. The form fills that in; a body that says
 *   "today" and names next week is a body that was edited, not a customer.
 * - `THIS_WEEK` — the end is no later than this week's Sunday (Monday-first).
 *   The start may be any day from today; "later this week" is still this week.
 * - anything else — `FLEXIBLE`, no urgency, or one of the older codes still
 *   sitting in stored rows — puts no constraint beyond the ones above.
 *
 * ## Why the clock is a parameter
 *
 * "Today" is the Istanbul day of `now`, never the server's UTC day: a request
 * sent at 00:30 in Istanbul is sent on the 15th even though the container's
 * clock still says the 14th. Taking `now` as an argument is what lets the
 * suite prove that at exactly that instant, rather than trusting the note.
 *
 * ## Storage
 *
 * Each day is stored at UTC midnight — `new Date('YYYY-MM-DD')`, the same
 * representation the single `preferredDate` has always had — so a new row and
 * a legacy row read back through the same formatter as the same day.
 */
export const PREFERRED_DATE_RANGE_MESSAGES = {
  incomplete: 'Tarih aralığının iki ucu da girilmeli.',
  invalid: 'Geçerli bir tarih girin (YYYY-AA-GG).',
  past: 'Geçmiş bir tarih seçilemez.',
  reversed: 'Başlangıç tarihi bitiş tarihinden sonra olamaz.',
  todayMismatch: '"Bugün" seçildiğinde tarih aralığı bugün olmalı.',
  thisWeekMismatch: '"Bu hafta" seçildiğinde bitiş tarihi bu haftanın pazarını geçemez.',
} as const;

export type PreferredDateRangeInput = {
  preferredDate?: string | null;
  preferredDateEnd?: string | null;
  urgency?: string | null;
};

export type PreferredDateRange = {
  preferredDate: Date | null;
  preferredDateEnd: Date | null;
};

function refuse(message: string): never {
  throw new BadRequestException(message);
}

function trimmed(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

export function normalizePreferredDateRange(
  input: PreferredDateRangeInput,
  now: Date = new Date(),
): PreferredDateRange {
  const start = trimmed(input.preferredDate);
  const end = trimmed(input.preferredDateEnd);

  if (start === null && end === null) {
    return { preferredDate: null, preferredDateEnd: null };
  }

  if (start === null || end === null) {
    refuse(PREFERRED_DATE_RANGE_MESSAGES.incomplete);
  }

  if (!isIsoDay(start) || !isIsoDay(end)) {
    refuse(PREFERRED_DATE_RANGE_MESSAGES.invalid);
  }

  const today = todayIsoDay(now);

  if (compareIsoDays(start, today) < 0) {
    refuse(PREFERRED_DATE_RANGE_MESSAGES.past);
  }

  if (compareIsoDays(start, end) > 0) {
    refuse(PREFERRED_DATE_RANGE_MESSAGES.reversed);
  }

  const urgency = trimmed(input.urgency);

  if (urgency === 'TODAY' && (start !== today || end !== today)) {
    refuse(PREFERRED_DATE_RANGE_MESSAGES.todayMismatch);
  }

  if (urgency === 'THIS_WEEK' && compareIsoDays(end, endOfWeekIsoDay(today)) > 0) {
    refuse(PREFERRED_DATE_RANGE_MESSAGES.thisWeekMismatch);
  }

  return { preferredDate: isoDayToStoredDate(start), preferredDateEnd: isoDayToStoredDate(end) };
}
