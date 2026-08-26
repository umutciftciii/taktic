import { expect, test } from '@playwright/test';
import {
  PHONE_SERIALS_PER_BLOCK,
  PHONE_WORKER_BLOCKS,
  createPhoneAllocator,
  uniquePhone,
} from '../src/fixtures';

/**
 * The one part of the fixture layer that has to be proved rather than trusted.
 *
 * Every other spec reads a phone number back through a screen, a unique index
 * or the SMS outbox, so two fixtures sharing a number never surfaces as "two
 * fixtures share a number". It surfaces as a failed insert in an unrelated
 * journey, or as a phone-verification test typing another fixture's one-time
 * code — a flake that accuses the feature under test instead of the fixture
 * that caused it. These checks put the claim where it can fail honestly.
 *
 * No browser and no database: the allocator is pure, so a defect in it is
 * reproducible without either.
 */

/**
 * The mapping this suite used to allocate numbers with, kept here and nowhere
 * else. A comment describing the defect would not fail if the defect came back;
 * the code itself, asserted against, does.
 */
function seedDerivedPhone(seed: string): string {
  const digits = seed.replace(/\D/g, '').padEnd(7, '0').slice(0, 7);
  return `0555${digits}`;
}

/** National format: the trunk zero, a mobile prefix, and nine more digits. */
const TURKISH_MOBILE = /^05\d{9}$/;

/**
 * How `outbox.ts` matches a recorded SMS back to the number a test filled in,
 * and what the API's normaliser turns into E.164. Two numbers that are distinct
 * as typed but equal under this are still one number to the suite.
 */
function subscriberDigits(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

/**
 * Far more than a run allocates — this suite uses a few dozen — and drawn from
 * a stated block, so repeating this spec never eats into the block the rest of
 * the run allocates from.
 */
const BATCH = 5_000;

test.describe('fixture phone allocation', () => {
  test('a fixture never receives a number another fixture already has', () => {
    const allocate = createPhoneAllocator(0);
    const phones = Array.from({ length: BATCH }, allocate);

    expect(new Set(phones).size, 'every allocated number must be distinct').toBe(BATCH);
    expect(
      new Set(phones.map(subscriberDigits)).size,
      'and must stay distinct in the subscriber-digit form the SMS outbox matches on',
    ).toBe(BATCH);
  });

  test('every allocated number is a well-formed Turkish mobile number', () => {
    const allocate = createPhoneAllocator(0);
    const phones = Array.from({ length: BATCH }, allocate);

    // Filtered rather than asserted one number at a time: a failure then names
    // the offending numbers instead of stopping at the first, and the check
    // costs milliseconds instead of minutes under `--repeat-each`.
    expect(phones.filter((phone) => !TURKISH_MOBILE.test(phone))).toEqual([]);
    // What the API's normaliser makes of them: eleven national digits become
    // the twelve-digit +90 number the verification SMS is sent to.
    expect(phones.filter((phone) => !/^\+90\d{10}$/.test(`+90${subscriberDigits(phone)}`))).toEqual(
      [],
    );
  });

  test('the seed-derived mapping this replaced collapsed distinct fixtures onto one number', () => {
    // Hex suffixes in the shape `uniqueSuffix()` produces. Dropping the letters
    // and right-padding with zeros is what made these pairs indistinguishable:
    // the first three share a digit subsequence, the last has no digits at all.
    const collidingSeeds: ReadonlyArray<readonly [string, string]> = [
      ['1a2b3c4d', 'a1b2c3d4'],
      ['12345678', '1234567a'],
      ['abcdef12', '12abcdef'],
      ['deadbeef', 'facecafe'],
    ];

    const allocate = createPhoneAllocator(0);

    for (const [left, right] of collidingSeeds) {
      expect(left, 'the seeds must genuinely differ').not.toBe(right);
      expect(
        seedDerivedPhone(left),
        'the defect being guarded against: two fixtures, one phone number',
      ).toBe(seedDerivedPhone(right));

      // What replaced it: one allocation per fixture, never a repeat, and no
      // dependence on whatever suffix the fixture happens to carry.
      expect(allocate()).not.toBe(allocate());
    }
  });

  test('a replacement worker process never reuses the numbers its predecessor issued', () => {
    // This is the case `--repeat-each` exposes and a counter alone gets wrong.
    // The database is truncated once, at the start of the run, but Playwright
    // starts a fresh process per repeat and per retry — so a block keyed on
    // anything a replacement worker inherits (the parallel slot, say) would
    // reissue numbers already inserted, and the insert would fail on the unique
    // index. Distinct worker indices must mean disjoint numbers.
    const perWorker = 500;
    const workers = [0, 1, 2, 17, PHONE_WORKER_BLOCKS - 1];
    const everyNumber = workers.flatMap((block) => {
      const allocate = createPhoneAllocator(block);
      return Array.from({ length: perWorker }, allocate);
    });

    expect(new Set(everyNumber).size, 'no number may be issued by two worker processes').toBe(
      everyNumber.length,
    );
    expect(everyNumber.filter((phone) => !TURKISH_MOBILE.test(phone))).toEqual([]);

    expect(() => createPhoneAllocator(PHONE_WORKER_BLOCKS)).toThrow(/no phone block/);
    expect(() => createPhoneAllocator(-1)).toThrow(/no phone block/);
  });

  test('exhausting a block fails loudly instead of wrapping onto used numbers', () => {
    const allocate = createPhoneAllocator(0);
    for (let i = 0; i < PHONE_SERIALS_PER_BLOCK; i++) {
      allocate();
    }

    expect(allocate).toThrow(/allocated all/);
  });

  test('the shared allocator keeps counting across tests in one worker process', () => {
    // Within a process the counter must never restart either: two tests in the
    // same worker write to the same untruncated database.
    const first = uniquePhone();
    const second = uniquePhone();

    expect(second).not.toBe(first);
    expect(Number(subscriberDigits(second))).toBeGreaterThan(Number(subscriberDigits(first)));
  });
});
