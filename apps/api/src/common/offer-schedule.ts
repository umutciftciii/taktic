import { BadRequestException, HttpStatus } from '@nestjs/common';
import limits from '@taktic/shared/limits.json';
import { addIsoDays, compareIsoDays, isIsoDay, isoDayToStoredDate, todayIsoDay } from './date-only';

/**
 * REL-002 §6.1 — a new offer's schedule: when the work starts and when it is
 * done, as calendar days in Europe/Istanbul.
 *
 * Both are required on every offer created from Faz 2 on; they are the dates a
 * later service-issue report is judged against, so an offer without them is a
 * match nobody can hold to anything. Older offers keep whatever they had —
 * NULL included — and every reader still accepts NULL (no backfill).
 *
 * The rules, all on the server's clock (never the body's):
 *
 *   - both fields present, each exactly `YYYY-MM-DD` and a real calendar day —
 *     a timestamp (`2026-10-12T09:00:00Z`) is refused, not truncated;
 *   - start ≥ today (starting today is fine, yesterday is not);
 *   - end ≥ start (a one-day job is fine);
 *   - end ≤ today + {@link OFFER_SCHEDULE_MAX_DAYS}.
 *
 * Stored as UTC midnight of the day (`isoDayToStoredDate`), the representation
 * `new Date('YYYY-MM-DD')` always produced, so old and new rows read back the
 * same way. The web form applies the same rules with the shared copy of these
 * functions (packages/shared `validateOfferSchedule`) and the same limit.
 */
export const OFFER_SCHEDULE_MAX_DAYS: number = limits.offerScheduleMaxDays;

export const OFFER_SCHEDULE_REQUIRED_CODE = 'OFFER_SCHEDULE_REQUIRED';
export const OFFER_SCHEDULE_INVALID_CODE = 'OFFER_SCHEDULE_INVALID';
export const OFFER_START_IN_PAST_CODE = 'OFFER_START_IN_PAST';
export const OFFER_END_BEFORE_START_CODE = 'OFFER_END_BEFORE_START';
export const OFFER_SCHEDULE_TOO_FAR_CODE = 'OFFER_SCHEDULE_TOO_FAR';

type ScheduleField = 'estimatedStartDate' | 'estimatedCompletionDate';

function scheduleError(code: string, message: string, field: ScheduleField | null, extra: object = {}) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code,
    message,
    ...(field ? { field } : {}),
    ...extra,
  });
}

function readDay(value: unknown, field: ScheduleField, label: string): string {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw scheduleError(OFFER_SCHEDULE_REQUIRED_CODE, `${label} zorunludur.`, field);
  }
  if (typeof value !== 'string' || !isIsoDay(value.trim())) {
    throw scheduleError(
      OFFER_SCHEDULE_INVALID_CODE,
      `${label} geçerli bir takvim günü olmalı (YYYY-MM-DD).`,
      field,
    );
  }
  return value.trim();
}

export function validateOfferSchedule(
  input: { estimatedStartDate?: unknown; estimatedCompletionDate?: unknown },
  now: Date = new Date(),
): { estimatedStartDate: Date; estimatedCompletionDate: Date } {
  const start = readDay(input.estimatedStartDate, 'estimatedStartDate', 'Başlangıç tarihi');
  const end = readDay(input.estimatedCompletionDate, 'estimatedCompletionDate', 'Bitiş tarihi');
  const today = todayIsoDay(now);
  const latest = addIsoDays(today, OFFER_SCHEDULE_MAX_DAYS);

  if (compareIsoDays(start, today) < 0) {
    throw scheduleError(OFFER_START_IN_PAST_CODE, 'Başlangıç tarihi bugünden önce olamaz.', 'estimatedStartDate', {
      today,
    });
  }
  if (compareIsoDays(end, start) < 0) {
    throw scheduleError(
      OFFER_END_BEFORE_START_CODE,
      'Bitiş tarihi başlangıç tarihinden önce olamaz.',
      'estimatedCompletionDate',
    );
  }
  if (compareIsoDays(end, latest) > 0) {
    throw scheduleError(
      OFFER_SCHEDULE_TOO_FAR_CODE,
      `Teklif takvimi en fazla ${OFFER_SCHEDULE_MAX_DAYS} gün ileriye verilebilir.`,
      'estimatedCompletionDate',
      { latest },
    );
  }

  return {
    estimatedStartDate: isoDayToStoredDate(start),
    estimatedCompletionDate: isoDayToStoredDate(end),
  };
}
