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
