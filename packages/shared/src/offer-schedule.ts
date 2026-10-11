import limits from '../limits.json';
import { addIsoDays, compareIsoDays, isIsoDay, todayIsoDay, type IsoDay } from './datetime';

/**
 * REL-002 §6.1 — an offer's schedule, as the web form checks it.
 *
 * The same rules, the same codes and the same horizon as the API's
 * authoritative check (apps/api/src/common/offer-schedule.ts), which cannot
 * import this package and keeps its own copy. Both read the horizon from
 * `limits.json`. The browser's `min`/`max`/`required` are a convenience; this
 * is what the server action runs before it calls the API, and the API checks
 * again on its own clock.
 */
export const OFFER_SCHEDULE_MAX_DAYS: number = limits.offerScheduleMaxDays;

export type OfferScheduleErrorCode =
  | 'OFFER_SCHEDULE_REQUIRED'
  | 'OFFER_SCHEDULE_INVALID'
  | 'OFFER_START_IN_PAST'
  | 'OFFER_END_BEFORE_START'
  | 'OFFER_SCHEDULE_TOO_FAR';

export const OFFER_SCHEDULE_ERROR_CODES: readonly OfferScheduleErrorCode[] = [
  'OFFER_SCHEDULE_REQUIRED',
  'OFFER_SCHEDULE_INVALID',
  'OFFER_START_IN_PAST',
  'OFFER_END_BEFORE_START',
  'OFFER_SCHEDULE_TOO_FAR',
];

/** The sentence a provider reads for each refusal. */
export const OFFER_SCHEDULE_ERROR_MESSAGES: Record<OfferScheduleErrorCode, string> = {
  OFFER_SCHEDULE_REQUIRED: 'Tahmini başlangıç ve bitiş tarihleri zorunludur.',
  OFFER_SCHEDULE_INVALID: 'Tarihler geçerli bir takvim günü olmalı.',
  OFFER_START_IN_PAST: 'Başlangıç tarihi bugünden önce olamaz.',
  OFFER_END_BEFORE_START: 'Bitiş tarihi başlangıç tarihinden önce olamaz.',
  OFFER_SCHEDULE_TOO_FAR: `Teklif takvimi en fazla ${OFFER_SCHEDULE_MAX_DAYS} gün ileriye verilebilir.`,
};

export function isOfferScheduleErrorCode(value: unknown): value is OfferScheduleErrorCode {
  return typeof value === 'string' && (OFFER_SCHEDULE_ERROR_CODES as readonly string[]).includes(value);
}

/** The window the date inputs offer: today … today + the horizon (Istanbul days). */
export function offerScheduleBounds(now: Date = new Date()): { min: IsoDay; max: IsoDay } {
  const today = todayIsoDay(now);
  return { min: today, max: addIsoDays(today, OFFER_SCHEDULE_MAX_DAYS) };
}

export function validateOfferSchedule(
  start: string | null | undefined,
  end: string | null | undefined,
  now: Date = new Date(),
): { ok: true } | { ok: false; code: OfferScheduleErrorCode } {
  const first = start?.trim() ?? '';
  const last = end?.trim() ?? '';
  if (!first || !last) return { ok: false, code: 'OFFER_SCHEDULE_REQUIRED' };
  if (!isIsoDay(first) || !isIsoDay(last)) return { ok: false, code: 'OFFER_SCHEDULE_INVALID' };

  const { min, max } = offerScheduleBounds(now);
  if (compareIsoDays(first, min) < 0) return { ok: false, code: 'OFFER_START_IN_PAST' };
  if (compareIsoDays(last, first) < 0) return { ok: false, code: 'OFFER_END_BEFORE_START' };
  if (compareIsoDays(last, max) > 0) return { ok: false, code: 'OFFER_SCHEDULE_TOO_FAR' };
  return { ok: true };
}
