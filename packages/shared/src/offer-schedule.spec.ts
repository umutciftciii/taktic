import { describe, expect, it } from 'vitest';
import { OFFER_SCHEDULE_MAX_DAYS, offerScheduleBounds, validateOfferSchedule } from './offer-schedule';

// 2026-10-11 21:30 UTC is already the 12th in Istanbul (UTC+3).
const NOW = new Date('2026-10-11T21:30:00Z');

describe('validateOfferSchedule', () => {
  it('reads "today" in Europe/Istanbul', () => {
    expect(offerScheduleBounds(NOW)).toEqual({ min: '2026-10-12', max: '2027-10-12' });
    expect(OFFER_SCHEDULE_MAX_DAYS).toBe(365);
  });

  it('accepts a schedule that starts today and a one-day job', () => {
    expect(validateOfferSchedule('2026-10-12', '2026-10-12', NOW)).toEqual({ ok: true });
    expect(validateOfferSchedule('2026-10-20', '2026-10-25', NOW)).toEqual({ ok: true });
    expect(validateOfferSchedule('2026-10-12', '2027-10-12', NOW)).toEqual({ ok: true });
  });

  it.each([
    [null, '2026-10-20', 'OFFER_SCHEDULE_REQUIRED'],
    ['2026-10-20', '  ', 'OFFER_SCHEDULE_REQUIRED'],
    ['2026-10-20T09:00:00Z', '2026-10-21', 'OFFER_SCHEDULE_INVALID'],
    ['2026-02-30', '2026-10-21', 'OFFER_SCHEDULE_INVALID'],
    ['2026-10-11', '2026-10-21', 'OFFER_START_IN_PAST'],
    ['2026-10-21', '2026-10-20', 'OFFER_END_BEFORE_START'],
    ['2026-10-21', '2027-10-13', 'OFFER_SCHEDULE_TOO_FAR'],
  ])('refuses %s → %s with %s', (start, end, code) => {
    expect(validateOfferSchedule(start, end, NOW)).toEqual({ ok: false, code });
  });
});
