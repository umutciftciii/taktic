import { describe, expect, it } from 'vitest';
import {
  TAKTIC_LOCALE,
  TAKTIC_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatIsoDay,
  formatTime,
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
