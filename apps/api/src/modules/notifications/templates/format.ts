/**
 * Turkish-locale formatting for the values that reach an e-mail body, plus the
 * one escape function every interpolation goes through.
 *
 * Every formatter here takes the value the database actually holds and returns
 * either a string or null. Null means "there is nothing true to say", and the
 * templates drop the whole row rather than printing a placeholder — a data
 * table that says "—" where a phone number should be reads as a bug, and one
 * that invents a plausible value is worse.
 */

/**
 * The zone the product is written for. Pinned rather than read from the process,
 * because a server that happens to run in UTC must not tell an Istanbul customer
 * their reset link was requested three hours ago.
 */
export const DISPLAY_TIME_ZONE = 'Europe/Istanbul';

/**
 * The one non-locale formatter here: the stored urgency code in words.
 *
 * Re-exported rather than defined, because the same table backs the two admin
 * and customer screens that render this column. A template must never reach for
 * `data.urgency` directly — that value is `THIS_WEEK`, not something to send
 * anybody.
 */
export { urgencyLabel } from '../../../common/urgency';

const LOCALE = 'tr-TR';

/**
 * Escapes for an HTML attribute or text node.
 *
 * Every dynamic value in a rendered e-mail passes through this. The values come
 * from customer- and provider-supplied fields — a business name, an offer note,
 * a request description — so treating them as markup would be a stored-XSS sink
 * in whichever client renders the mail, and a link-injection vector in a message
 * whose whole point is that its links are trustworthy.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Money, from the minor units the database stores.
 *
 * `1.234 ₺` — dot thousands separator, a space, then the sign — which is the
 * shape the design specifies. Kuruş are printed only when there are any: an
 * offer of 2.400,00 TRY reads as `2.400 ₺` exactly as designed, and one of
 * 2.400,50 keeps its fifty kuruş rather than being rounded into a figure the
 * provider never quoted.
 */
export function formatMoneyMinor(amountMinor: number | null | undefined): string | null {
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) {
    return null;
  }

  const major = amountMinor / 100;
  const digits = Number.isInteger(major) ? 0 : 2;

  const formatted = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major);

  return `${formatted} ₺`;
}

/** `27 Ağustos 2026, 14:12`. */
export function formatDateTime(value: Date | string | null | undefined): string | null {
  const moment = toDate(value);
  if (!moment) {
    return null;
  }

  const date = new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(moment);

  const time = new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: DISPLAY_TIME_ZONE,
  }).format(moment);

  return `${date}, ${time}`;
}

/** `27 Ağustos 2026`, for a date the customer chose rather than a system moment. */
export function formatDate(value: Date | string | null | undefined): string | null {
  const moment = toDate(value);
  if (!moment) {
    return null;
  }

  return new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(moment);
}

/** `2 kredi`. Turkish has no plural suffix here, so the noun never changes. */
export function formatCredits(amount: number | null | undefined): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return null;
  }

  return `${new Intl.NumberFormat(LOCALE).format(amount)} kredi`;
}

/** `İstanbul, Kadıköy` — district first, the way an address is read aloud. */
export function formatLocation(
  city: string | null | undefined,
  district: string | null | undefined,
): string | null {
  const parts = [district, city].map((part) => part?.trim()).filter(isNonEmpty);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** `Kombi Servisi, Klima Montajı`, or null when the list is empty. */
export function formatList(values: readonly (string | null | undefined)[]): string | null {
  const parts = values.map((value) => value?.trim()).filter(isNonEmpty);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Trims a free-text field a customer or provider typed to something a one-line
 * table cell can hold.
 *
 * Truncation rather than omission: the row is the recipient's own data and
 * saying "there is a note, here is the start of it" is more useful than saying
 * nothing. The full text is on the page the CTA links to.
 */
export function truncate(value: string | null | undefined, maxLength = 180): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const collapsed = trimmed.replace(/\s+/g, ' ');
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

export function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const moment = value instanceof Date ? value : new Date(value);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
