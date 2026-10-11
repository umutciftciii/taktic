import { MatchRoundStatus, ServiceIssueReason, ServiceRequestStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isoDayToStoredDate } from '../src/common/date-only';
import {
  eligibilityBasisFor,
  evaluateServiceIssueEligibility,
  maskContactDetailsInNote,
  normalizeServiceIssueNote,
} from '../src/modules/service-issues/service-issue-eligibility';
import { customerServiceIssueView } from '../src/modules/service-issues/service-issue-view';

/**
 * REL-002 Faz 3 §6 — the eligibility matrix as a pure function of the
 * accepted offer's promised days and the server's clock, in Europe/Istanbul
 * calendar days. Istanbul is UTC+3 all year: 21:00Z is midnight there.
 */

const schedule = (start: string, end: string) => ({
  start: isoDayToStoredDate(start),
  end: isoDayToStoredDate(end),
});

const available = (start: string, end: string, nowIso: string) =>
  evaluateServiceIssueEligibility(schedule(start, end), new Date(nowIso)).availableReasons;

describe('Istanbul day boundary', () => {
  it('the start day is not "passed" until it is over in Istanbul (23:59:59 vs 00:00)', () => {
    // 2026-10-12 23:59:59 in Istanbul — still the promised day.
    expect(available('2026-10-12', '2026-10-15', '2026-10-12T20:59:59.000Z')).toEqual([
      ServiceIssueReason.PROVIDER_CANCELLED_BEFORE_START,
    ]);
    // 2026-10-13 00:00:00 in Istanbul — the start day has passed.
    expect(available('2026-10-12', '2026-10-15', '2026-10-12T21:00:00.000Z')).toEqual([
      ServiceIssueReason.PROVIDER_NO_SHOW,
      ServiceIssueReason.WORK_NOT_STARTED,
      ServiceIssueReason.PROVIDER_CANCELLED_BEFORE_START,
      ServiceIssueReason.OTHER,
    ]);
  });

  it('UTC midnight is still the previous day nowhere that matters: 23:30Z on the 12th is the 13th in Istanbul', () => {
    expect(available('2026-10-12', '2026-10-12', '2026-10-12T23:30:00.000Z')).toHaveLength(6);
  });

  it('a one-day job (start = end): nothing but the cancellation on the day, everything the day after', () => {
    expect(available('2026-10-12', '2026-10-12', '2026-10-12T12:00:00.000Z')).toEqual([
      ServiceIssueReason.PROVIDER_CANCELLED_BEFORE_START,
    ]);
    expect(available('2026-10-12', '2026-10-12', '2026-10-13T06:00:00.000Z')).toHaveLength(6);
  });

  it('the end gate: not-completed and stopped open the day after the end', () => {
    const between = evaluateServiceIssueEligibility(schedule('2026-10-10', '2026-10-14'), new Date('2026-10-14T20:00:00.000Z'));
    expect(between.availableReasons).not.toContain(ServiceIssueReason.WORK_NOT_COMPLETED);
    expect(between.availableReasons).not.toContain(ServiceIssueReason.PROVIDER_STOPPED_WORK);
    expect(between.nextOpensOn).toBe('2026-10-15');
    expect(between.reasons.find((entry) => entry.reason === ServiceIssueReason.PROVIDER_STOPPED_WORK)).toEqual({
      reason: ServiceIssueReason.PROVIDER_STOPPED_WORK,
      available: false,
      opensOn: '2026-10-15',
    });
    expect(available('2026-10-10', '2026-10-14', '2026-10-14T21:00:00.000Z')).toHaveLength(6);
  });

  it('before the start: next opening is the day after the start', () => {
    const before = evaluateServiceIssueEligibility(schedule('2026-10-20', '2026-10-25'), new Date('2026-10-12T09:00:00.000Z'));
    expect(before.nextOpensOn).toBe('2026-10-21');
  });
});

describe('legacy schedule', () => {
  it.each([
    ['no start', { start: null, end: isoDayToStoredDate('2026-10-12') }],
    ['no end', { start: isoDayToStoredDate('2026-10-12'), end: null }],
    ['neither', { start: null, end: null }],
  ])('%s: support only, no reason at all — not even the cancellation', (_label, promised) => {
    const result = evaluateServiceIssueEligibility(promised, new Date('2026-12-01T09:00:00.000Z'));
    expect(result.supportOnly).toBe(true);
    expect(result.availableReasons).toEqual([]);
  });
});

describe('basis, note normalisation and masking', () => {
  it('the cancellation rests on the provider’s word; everything else on the offer’s dates', () => {
    expect(eligibilityBasisFor(ServiceIssueReason.PROVIDER_CANCELLED_BEFORE_START)).toBe('PROVIDER_CANCELLATION');
    expect(eligibilityBasisFor(ServiceIssueReason.PROVIDER_NO_SHOW)).toBe('OFFER_DATES');
    expect(eligibilityBasisFor(ServiceIssueReason.OTHER)).toBe('OFFER_DATES');
  });

  it('trims and collapses whitespace; empty is null', () => {
    expect(normalizeServiceIssueNote('  a \n\t b  ')).toBe('a b');
    expect(normalizeServiceIssueNote('   ')).toBeNull();
    expect(normalizeServiceIssueNote(undefined)).toBeNull();
  });

  it('masks phone numbers, e-mail addresses and links for the provider', () => {
    const masked = maskContactDetailsInNote('Gelmedi, beni 0532 123 45 67 veya ali@example.com ile arasın, www.example.com');
    expect(masked).not.toMatch(/0532|ali@example\.com|example\.com/);
    expect(masked).toContain('[gizlendi]');
    expect(maskContactDetailsInNote('Usta hiç gelmedi.')).toBe('Usta hiç gelmedi.');
  });
});

describe('customer view', () => {
  const base = {
    enabled: true,
    status: ServiceRequestStatus.MATCHED,
    matchedOfferId: 'o1',
    current: {
      id: 'mr1_r',
      roundNumber: 1,
      status: MatchRoundStatus.MATCHED,
      matchedOfferId: 'o1',
      schedule: schedule('2026-10-10', '2026-10-14'),
    },
    now: new Date('2026-10-12T09:00:00.000Z'),
  };

  it('a matched, scheduled round can be reported, and says what the report will do', () => {
    expect(customerServiceIssueView(base)).toMatchObject({
      canReport: true,
      roundId: 'mr1_r',
      consequence: 'REOPEN',
      maxAutoRoundsReached: false,
      unavailableReason: null,
    });
    expect(customerServiceIssueView({ ...base, current: { ...base.current, roundNumber: 3 } })).toMatchObject({
      consequence: 'ADMIN_REVIEW',
      maxAutoRoundsReached: true,
    });
  });

  it('switch off, unmatched and inconsistent projections cannot report', () => {
    expect(customerServiceIssueView({ ...base, enabled: false })).toMatchObject({
      canReport: false,
      unavailableReason: 'FEATURE_DISABLED',
      roundId: null,
    });
    expect(customerServiceIssueView({ ...base, status: ServiceRequestStatus.APPROVED })).toMatchObject({
      canReport: false,
      unavailableReason: 'NOT_MATCHED',
    });
    expect(customerServiceIssueView({ ...base, matchedOfferId: 'other' }).canReport).toBe(false);
  });
});
