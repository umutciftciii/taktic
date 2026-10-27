/**
 * The one way this product turns an instant into text.
 *
 * Every surface — the customer panel, the provider panel, the admin screens and
 * the e-mail templates — has to agree on two things, and neither of them may be
 * inherited from the machine that happens to be rendering:
 *
 * 1. **The zone.** Node in a container runs in UTC; a browser in Istanbul runs
 *    in UTC+3. A formatter that lets the runtime decide therefore produces one
 *    string during server rendering and a different one during hydration, and
 *    React discards the server tree and re-renders the whole branch. That is
 *    not a cosmetic bug: it is the hydration failure this module exists to end.
 * 2. **The locale.** `toLocaleString()` with no locale reads the host's, so a
 *    server with a different ICU default silently renders a different month
 *    name than the browser does.
 *
 * Both are pinned below. The output is the same string on both sides of a
 * render, on every machine, in every environment — so SSR HTML and the first
 * client render are identical by construction rather than by luck.
 *
 * Nothing here reads `Date.now()`. These are pure functions of the instant they
 * are handed, which is what makes them safe to call during render.
 */

/**
 * The zone the product is written for.
 *
 * Turkey has observed a single, permanent UTC+3 since 2016, so this is a real
 * answer rather than a simplification: there is no daylight transition for a
 * fixed zone to get wrong, and every party to a request — customer, provider,
 * operator — is looking at the same clock.
 *
 * The API's e-mail templates pin the identical value (see
 * apps/api/src/modules/notifications/templates/format.ts); a link in a message
 * and the page it opens must not disagree about when something happened.
 */
export const TAKTIC_TIME_ZONE = 'Europe/Istanbul';

/** Pinned for the same reason as the zone: the host must not get a vote. */
export const TAKTIC_LOCALE = 'tr-TR';

/** What every formatter here returns for a value there is nothing true to say about. */
const EMPTY = '-';

export type DateInput = Date | string | number | null | undefined;

/**
 * Formatter instances are created once and reused.
 *
 * `Intl.DateTimeFormat` construction is the expensive half of formatting, and
 * these are called once per row of a list. Caching them is also what guarantees
 * two calls cannot resolve different options.
 */
const dateFormatter = new Intl.DateTimeFormat(TAKTIC_LOCALE, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: TAKTIC_TIME_ZONE,
});

const dateTimeFormatter = new Intl.DateTimeFormat(TAKTIC_LOCALE, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: TAKTIC_TIME_ZONE,
});

const timeFormatter = new Intl.DateTimeFormat(TAKTIC_LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: TAKTIC_TIME_ZONE,
});

/**
 * The ISO calendar day, in the product's zone.
 *
 * For grouping and for date inputs — never for display. It is deliberately not
 * locale-formatted: an `<input type="date">` value and a bucket key are data.
 */
const isoDayFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TAKTIC_TIME_ZONE,
});

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `28 Ağu 2026`.
 *
 * An unparseable value comes back as the placeholder rather than as itself: the
 * previous implementations echoed the raw input on failure, which put a stored
 * value on screen in the one case nobody had thought about.
 */
export function formatDate(value: DateInput): string {
  const moment = toDate(value);
  return moment ? dateFormatter.format(moment) : EMPTY;
}

/** `28 Ağu 2026 02:29`. */
export function formatDateTime(value: DateInput): string {
  const moment = toDate(value);
  if (!moment) {
    return EMPTY;
  }

  // Joined from the two parts rather than taken from one formatter, because
  // `dateStyle`-free option bags render the separator differently across ICU
  // versions and this string is asserted on.
  return `${dateFormatter.format(moment)} ${timeFormatter.format(moment)}`;
}

/** `02:29`. */
export function formatTime(value: DateInput): string {
  const moment = toDate(value);
  return moment ? timeFormatter.format(moment) : EMPTY;
}

/** `2026-08-28`, in the product's zone. Data, not display — see above. */
export function formatIsoDay(value: DateInput): string {
  const moment = toDate(value);
  return moment ? isoDayFormatter.format(moment) : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Date-only arithmetic
//
// A request's preferred date range is two calendar days, not two instants: the
// customer means "the 15th", whatever hour the server happens to write it at.
// Everything below therefore works on `YYYY-MM-DD` strings and does its
// arithmetic on `Date.UTC(...)` of those strings — a fixed, zone-free calendar —
// and the only place a real clock enters is `todayIsoDay`, which reads it
// through the product's zone. The API keeps a byte-for-byte mirror of these
// functions (apps/api/src/common/date-only.ts); it cannot import this package.
// ─────────────────────────────────────────────────────────────────────────────

export type IsoDay = string;

const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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

/**
 * `15 Eyl 2026 – 21 Eyl 2026`, or a single date when the ends agree or the
 * end is absent — which is what every request written before the range
 * existed carries. Accepts stored instants as well as ISO days, because the
 * projections hand over what the column holds.
 */
export function formatDateRange(start: DateInput, end: DateInput): string {
  const first = formatDate(start);
  if (first === EMPTY) {
    return EMPTY;
  }

  const last = formatDate(end);
  if (last === EMPTY || last === first) {
    return first;
  }

  return `${first} – ${last}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Istanbul day boundaries (TIMEZONE-001)
//
// A filter that says "from the 27th to the 27th" means the whole of that day in
// Istanbul, which is a window of instants: [00:00 on the 27th, 00:00 on the
// 28th) Istanbul time. The end is exclusive — the start of the next day, never
// `23:59:59.999` of this one — so nothing that happens in the last millisecond
// falls between two days.
//
// The zone's offset is read from `Intl` for the day in question rather than
// written down as `+03:00`, and nothing here touches the host's zone: a server
// in UTC, a laptop in Istanbul and a CI runner in New York draw the same line.
// The API keeps a byte-for-byte mirror (apps/api/src/common/date-only.ts).
// ─────────────────────────────────────────────────────────────────────────────

const zoneWallClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TAKTIC_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** How far Istanbul's wall clock is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of zoneWallClockFormatter.formatToParts(new Date(instant))) {
    parts[part.type] = Number(part.value);
  }
  const wallClock = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wallClock - Math.floor(instant / 1000) * 1000;
}

/** The instant `day` begins in Europe/Istanbul: `2026-10-27` → `2026-10-26T21:00:00.000Z`. */
export function isoDayStart(day: IsoDay): Date {
  const wallMidnight = isoDayToUtc(day).getTime();
  // Asked twice so a zone whose offset changed between the two readings still
  // lands on its own midnight; with today's fixed UTC+3 both answers agree.
  const guess = wallMidnight - zoneOffsetMs(wallMidnight);
  return new Date(wallMidnight - zoneOffsetMs(guess));
}

/**
 * Two Istanbul days as a half-open window of instants: `gte` is the start of
 * `from`, `lt` the start of the day after `to`. An absent end stays `null`, so
 * a one-sided filter is one-sided. The days are not checked here — see
 * `orderIsoDayRange` for turning raw input into a pair this can take.
 */
export function isoDayRangeBounds(
  from: IsoDay | null | undefined,
  to: IsoDay | null | undefined,
): { gte: Date | null; lt: Date | null } {
  return {
    gte: from ? isoDayStart(from) : null,
    lt: to ? isoDayStart(addIsoDays(to, 1)) : null,
  };
}

/**
 * Two raw date-filter inputs as a usable pair of days: anything that is not a
 * real `YYYY-MM-DD` day is dropped (a one-sided or empty filter is still a
 * filter), and a pair given in reverse is put in order rather than turned into
 * a window that matches nothing.
 */
export function orderIsoDayRange(from: unknown, to: unknown): { from: IsoDay | null; to: IsoDay | null } {
  const first = typeof from === 'string' && isIsoDay(from.trim()) ? from.trim() : null;
  const last = typeof to === 'string' && isIsoDay(to.trim()) ? to.trim() : null;
  if (first && last && compareIsoDays(first, last) > 0) {
    return { from: last, to: first };
  }
  return { from: first, to: last };
}
