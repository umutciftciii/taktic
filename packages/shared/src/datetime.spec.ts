import { describe, expect, it } from 'vitest';
import {
  TAKTIC_LOCALE,
  TAKTIC_TIME_ZONE,
  formatDate,
  formatDateTime,
  addIsoDays,
  compareIsoDays,
  endOfWeekIsoDay,
  formatDateRange,
  formatIsoDay,
  formatTime,
  isIsoDay,
  todayIsoDay,
} from './datetime';

/**
 * The hydration guarantee, stated as arithmetic.
 *
 * These formatters exist because the same instant used to render as two
 * different strings: once on a server in UTC and once in a browser in UTC+3,
 * three hours apart, which is what tore the offer detail tree down on
 * hydration. Every case below picks an instant where the host's zone would
 * change the answer, and pins the answer the product's zone gives.
 */

/**
 * 27 August 2026, 23:29 UTC — the instant behind the reported failure. In UTC
 * it is the 27th at 23:29; in Istanbul it is already the 28th at 02:29.
 */
const ACROSS_MIDNIGHT = '2026-08-27T23:29:00.000Z';

describe('display formatting', () => {
  it('renders the product zone, not the host zone', () => {
    expect(formatDateTime(ACROSS_MIDNIGHT)).toBe('28 Ağu 2026 02:29');
    expect(formatDate(ACROSS_MIDNIGHT)).toBe('28 Ağu 2026');
    expect(formatTime(ACROSS_MIDNIGHT)).toBe('02:29');
    expect(formatIsoDay(ACROSS_MIDNIGHT)).toBe('2026-08-28');
  });

  it('produces the string a UTC host and an Istanbul browser would disagree on', () => {
    // The two renderings this module replaced. Their disagreement is the bug;
    // asserting it here is what makes the fix a guarantee rather than a habit.
    const asUtcHost = new Intl.DateTimeFormat(TAKTIC_LOCALE, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }).format(new Date(ACROSS_MIDNIGHT));

    const asIstanbulBrowser = new Intl.DateTimeFormat(TAKTIC_LOCALE, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: TAKTIC_TIME_ZONE,
    }).format(new Date(ACROSS_MIDNIGHT));

    expect(asUtcHost).not.toBe(asIstanbulBrowser);
    // Whichever host runs it, this module answers with the Istanbul reading.
    expect(formatDateTime(ACROSS_MIDNIGHT)).toContain('02:29');
    expect(formatDateTime(ACROSS_MIDNIGHT)).not.toContain('23:29');
  });

  it('does not change its answer when the host time zone changes', () => {
    // TZ is what a container sets and a developer's laptop does not. Nothing
    // here reads a local-time method, so moving it must not move the output —
    // which is exactly the property SSR and hydration depend on.
    //
    // Reached through globalThis rather than a bare `process`: this package is
    // bundled into the browser, and it must not acquire a Node type dependency
    // for the sake of a test.
    const host = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
    const original = host?.env.TZ;

    try {
      const readings = ['UTC', 'Europe/Istanbul', 'America/New_York', 'Asia/Tokyo'].map((zone) => {
        if (host) {
          host.env.TZ = zone;
        }
        return formatDateTime(ACROSS_MIDNIGHT);
      });

      expect(new Set(readings).size).toBe(1);
      expect(readings[0]).toBe('28 Ağu 2026 02:29');
    } finally {
      if (host) {
        if (original === undefined) {
          delete host.env.TZ;
        } else {
          host.env.TZ = original;
        }
      }
    }
  });

  it('is stable across repeated calls, so a list cannot render two spellings', () => {
    const first = formatDateTime(ACROSS_MIDNIGHT);
    for (let i = 0; i < 5; i += 1) {
      expect(formatDateTime(ACROSS_MIDNIGHT)).toBe(first);
    }
  });

  it('accepts the shapes the API actually returns', () => {
    const instant = new Date(ACROSS_MIDNIGHT);
    expect(formatDateTime(instant)).toBe(formatDateTime(ACROSS_MIDNIGHT));
    expect(formatDateTime(instant.getTime())).toBe(formatDateTime(ACROSS_MIDNIGHT));
  });

  it('answers with a placeholder rather than echoing an unusable value', () => {
    for (const value of [null, undefined, '', 'not-a-date']) {
      expect(formatDate(value)).toBe('-');
      expect(formatDateTime(value)).toBe('-');
      expect(formatTime(value)).toBe('-');
    }

    // A stored value must never reach the screen because parsing failed.
    expect(formatDateTime('not-a-date')).not.toContain('not-a-date');
  });

  it('pins the zone the whole product is written for', () => {
    expect(TAKTIC_TIME_ZONE).toBe('Europe/Istanbul');
    expect(TAKTIC_LOCALE).toBe('tr-TR');
  });
});

/**
 * Date-only arithmetic for the request's preferred date range.
 *
 * Every case is chosen so that "the server's UTC day" and "the day in
 * Istanbul" — or a naive `getDay()` on a local Date — would give a different
 * answer. The right answer is always the calendar in Europe/Istanbul.
 */
describe('date-only helpers', () => {
  it('names today by the Istanbul calendar, not the UTC one', () => {
    // 14 September 21:30 UTC is already 15 September 00:30 in Istanbul.
    expect(todayIsoDay(new Date('2026-09-14T21:30:00.000Z'))).toBe('2026-09-15');
    // ...and 20:59 UTC is still the 14th on both clocks.
    expect(todayIsoDay(new Date('2026-09-14T20:59:00.000Z'))).toBe('2026-09-14');
  });

  it('recognises a real calendar day and nothing else', () => {
    expect(isIsoDay('2026-09-15')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('2026-9-5')).toBe(false);
    expect(isIsoDay('2026-09-15T00:00:00Z')).toBe(false);
    expect(isIsoDay('15.09.2026')).toBe(false);
    expect(isIsoDay('')).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addIsoDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addIsoDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addIsoDays('2026-09-15', 0)).toBe('2026-09-15');
  });

  it('ends the week on Sunday, Monday-first', () => {
    // 15 September 2024 is a Sunday: the week ends the same day.
    expect(endOfWeekIsoDay('2024-09-15')).toBe('2024-09-15');
    // 15 September 2026 is a Tuesday.
    expect(endOfWeekIsoDay('2026-09-15')).toBe('2026-09-20');
    // A Monday has six days to go.
    expect(endOfWeekIsoDay('2026-09-14')).toBe('2026-09-20');
    // Month boundary: Wednesday 30 September → Sunday 4 October.
    expect(endOfWeekIsoDay('2026-09-30')).toBe('2026-10-04');
    // Year boundary: Wednesday 30 December 2026 → Sunday 3 January 2027.
    expect(endOfWeekIsoDay('2026-12-30')).toBe('2027-01-03');
  });

  it('orders days as strings, which is what the ISO form is for', () => {
    expect(compareIsoDays('2026-09-15', '2026-09-20')).toBeLessThan(0);
    expect(compareIsoDays('2026-10-01', '2026-09-30')).toBeGreaterThan(0);
    expect(compareIsoDays('2026-09-15', '2026-09-15')).toBe(0);
  });

  it('words a range as one date when the two ends agree or the end is missing', () => {
    expect(formatDateRange('2026-09-15', '2026-09-21')).toBe('15 Eyl 2026 – 21 Eyl 2026');
    expect(formatDateRange('2026-09-15', '2026-09-15')).toBe('15 Eyl 2026');
    expect(formatDateRange('2026-09-15', null)).toBe('15 Eyl 2026');
    expect(formatDateRange(null, null)).toBe('-');
    // A legacy row stored the day as UTC midnight; it still reads as that day.
    expect(formatDateRange(new Date('2026-09-15T00:00:00.000Z'), null)).toBe('15 Eyl 2026');
  });
});
