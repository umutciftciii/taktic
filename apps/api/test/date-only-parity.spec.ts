import { afterEach, describe, expect, it } from 'vitest';
import {
  addIsoDays,
  compareIsoDays,
  endOfWeekIsoDay,
  isIsoDay,
  isoDayRangeBounds,
  isoDayStart,
  isoDayToStoredDate,
  toIsoDay,
  todayIsoDay,
} from '../src/common/date-only';

/**
 * The API's copy of the shared date-only helpers, held to the same cases as
 * `packages/shared/src/datetime.spec.ts`. The two files are copies because the
 * API cannot import the shared package (see `urgency-label-parity.spec.ts`);
 * these cases are what keeps the copies saying the same thing about the same
 * calendar. Every case is chosen so that the server's UTC day, or a naive
 * local-time `getDay()`, would answer differently.
 */
describe('date-only helpers (API mirror)', () => {
  it('names today by the Istanbul calendar, not the UTC one', () => {
    expect(todayIsoDay(new Date('2026-09-14T21:30:00.000Z'))).toBe('2026-09-15');
    expect(todayIsoDay(new Date('2026-09-14T20:59:00.000Z'))).toBe('2026-09-14');
  });

  it('recognises a real calendar day and nothing else', () => {
    expect(isIsoDay('2026-09-15')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('2026-9-5')).toBe(false);
    expect(isIsoDay('2026-09-15T00:00:00Z')).toBe(false);
    expect(isIsoDay('15.09.2026')).toBe(false);
    expect(isIsoDay('')).toBe(false);
    expect(isIsoDay(null)).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addIsoDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addIsoDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('ends the week on Sunday, Monday-first', () => {
    expect(endOfWeekIsoDay('2024-09-15')).toBe('2024-09-15'); // a Sunday
    expect(endOfWeekIsoDay('2026-09-15')).toBe('2026-09-20'); // a Tuesday
    expect(endOfWeekIsoDay('2026-09-14')).toBe('2026-09-20'); // a Monday
    expect(endOfWeekIsoDay('2026-09-30')).toBe('2026-10-04'); // month boundary
    expect(endOfWeekIsoDay('2026-12-30')).toBe('2027-01-03'); // year boundary
  });

  it('orders days as strings', () => {
    expect(compareIsoDays('2026-09-15', '2026-09-20')).toBeLessThan(0);
    expect(compareIsoDays('2026-10-01', '2026-09-30')).toBeGreaterThan(0);
    expect(compareIsoDays('2026-09-15', '2026-09-15')).toBe(0);
  });

  it('stores a day as UTC midnight and reads it back as the same day', () => {
    // The legacy representation: `new Date('2026-09-15')`.
    expect(isoDayToStoredDate('2026-09-15').toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(toIsoDay(isoDayToStoredDate('2026-09-15'))).toBe('2026-09-15');
    expect(toIsoDay(new Date('2026-09-15T00:00:00.000Z'))).toBe('2026-09-15');
    // Year boundary: 31 December at UTC midnight is still 31 December in Istanbul.
    expect(toIsoDay(isoDayToStoredDate('2026-12-31'))).toBe('2026-12-31');
    expect(toIsoDay(null)).toBe('');
    expect(toIsoDay('not a date')).toBe('');
  });
});

/** TIMEZONE-001: the same cases as the shared "Istanbul day boundaries" block. */
describe('Istanbul day boundaries (API mirror)', () => {
  const hostZone = process.env.TZ;
  afterEach(() => {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  });

  it('starts a day at Istanbul midnight, across month, year and leap-day ends', () => {
    expect(isoDayStart('2026-10-27').toISOString()).toBe('2026-10-26T21:00:00.000Z');
    expect(isoDayStart('2026-11-01').toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(isoDayStart('2027-01-01').toISOString()).toBe('2026-12-31T21:00:00.000Z');
    expect(isoDayStart('2028-02-29').toISOString()).toBe('2028-02-28T21:00:00.000Z');
    expect(todayIsoDay(isoDayStart('2026-10-27'))).toBe('2026-10-27');
    expect(todayIsoDay(new Date(isoDayStart('2026-10-27').getTime() - 1))).toBe('2026-10-26');
  });

  it('follows the zone rules of the day itself, not a written-down offset', () => {
    expect(isoDayStart('2015-07-01').toISOString()).toBe('2015-06-30T21:00:00.000Z');
    expect(isoDayStart('2015-01-01').toISOString()).toBe('2014-12-31T22:00:00.000Z');
  });

  it('turns a one-day filter into exactly that day, end exclusive, and leaves a missing end open', () => {
    const { gte, lt } = isoDayRangeBounds('2026-10-27', '2026-10-27');
    expect(gte?.toISOString()).toBe('2026-10-26T21:00:00.000Z');
    expect(lt?.toISOString()).toBe('2026-10-27T21:00:00.000Z');
    expect(isoDayRangeBounds('2026-10-01', '2026-10-31').lt?.toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(isoDayRangeBounds('2026-10-27', null).lt).toBeNull();
    expect(isoDayRangeBounds(undefined, '2026-10-27').gte).toBeNull();
  });

  it('draws the same line in every host zone', () => {
    for (const zone of ['UTC', 'Europe/Istanbul', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
      process.env.TZ = zone;
      const { gte, lt } = isoDayRangeBounds('2026-11-01', '2026-11-01');
      expect([gte?.toISOString(), lt?.toISOString()], zone).toEqual([
        '2026-10-31T21:00:00.000Z',
        '2026-11-01T21:00:00.000Z',
      ]);
    }
  });
});
