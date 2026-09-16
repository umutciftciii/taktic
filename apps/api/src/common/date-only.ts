/**
 * Date-only arithmetic for a request's preferred date range.
 *
 * A mirror of the "Date-only arithmetic" section of
 * `packages/shared/src/datetime.ts`, which the web and admin apps read. Copied
 * rather than imported for the same reason `urgency.ts` is: this package
 * compiles with `rootDir: src` and the shared package ships no build output.
 * `test/date-only-parity.spec.ts` runs the shared spec's cases against this
 * copy, so the two cannot drift in silence.
 *
 * The rule the whole range rests on: a preferred date is a *calendar day* in
 * Europe/Istanbul, never an instant. Every function here therefore works on
 * `YYYY-MM-DD` strings and does its arithmetic on `Date.UTC(...)` of those
 * strings — a fixed, zone-free calendar. The only clock read is in
 * `todayIsoDay`, and it is read through the product's zone, so a server
 * running at 21:30 UTC on the 14th correctly says "today is the 15th".
 */

export const TAKTIC_TIME_ZONE = 'Europe/Istanbul';

export type IsoDay = string;

const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isoDayFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TAKTIC_TIME_ZONE,
});

/** `2026-09-15` and nothing else: no time part, no other order, and a day that exists. */
export function isIsoDay(value: unknown): value is IsoDay {
  if (typeof value !== 'string') {
    return false;
  }

  const match = ISO_DAY_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/** The calendar day it is right now in Europe/Istanbul. The one clock read in this file. */
export function todayIsoDay(now: Date = new Date()): IsoDay {
  return isoDayFormatter.format(now);
}

/** The ISO day a stored instant falls on, in the product's zone. `''` for nothing. */
export function toIsoDay(value: Date | string | null | undefined): IsoDay {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const moment = value instanceof Date ? value : new Date(value);
  return Number.isNaN(moment.getTime()) ? '' : isoDayFormatter.format(moment);
}

/**
 * The instant a day is stored as: UTC midnight of that calendar day.
 *
 * This is what `new Date('2026-09-15')` has always produced for the legacy
 * single date, so new rows and old rows carry the same representation, and
 * `toIsoDay` reads both back as the day that was typed (03:00 in Istanbul is
 * still the same date).
 */
export function isoDayToStoredDate(day: IsoDay): Date {
  return isoDayToUtc(day);
}

function isoDayToUtc(day: IsoDay): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date));
}

function utcToIsoDay(utc: Date): IsoDay {
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const date = String(utc.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

/** `days` may be negative. Month and year ends roll over as the calendar does. */
export function addIsoDays(day: IsoDay, days: number): IsoDay {
  const utc = isoDayToUtc(day);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utcToIsoDay(utc);
}

/**
 * The Sunday that closes the week containing `day`, Monday-first as the
 * Turkish calendar runs. A Sunday is its own answer.
 */
export function endOfWeekIsoDay(day: IsoDay): IsoDay {
  const weekday = isoDayToUtc(day).getUTCDay(); // 0 = Sunday
  return addIsoDays(day, (7 - weekday) % 7);
}

/** Negative, zero or positive — the ISO form sorts lexically by construction. */
export function compareIsoDays(left: IsoDay, right: IsoDay): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
