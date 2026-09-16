import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addIsoDays, endOfWeekIsoDay, todayIsoDay } from '../src/common/date-only';
import {
  PREFERRED_DATE_RANGE_MESSAGES,
  normalizePreferredDateRange,
} from '../src/modules/service-requests/preferred-date-range';
import {
  createCategory,
  createTestApp,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * The preferred date range, as a rule about calendar days.
 *
 * The form fills the two dates in from the urgency the customer picked, but
 * this endpoint is public and the browser is not the rule: a range that is in
 * the past, reversed, half-given, malformed or plainly at odds with the urgency
 * beside it is refused here, in Istanbul's calendar, whatever day the server's
 * own clock is on. Both ends empty stays legal — every request created before
 * the range existed looks like that, and so does "Esnek".
 */

// ── The pure rule, with an injected clock ─────────────────────────────────────

describe('normalizePreferredDateRange', () => {
  // 14 September 21:30 UTC is already 15 September in Istanbul. A rule that
  // read the server's UTC day would call the 15th "tomorrow" and let the 14th
  // through as "today"; both are wrong for the customer.
  const ISTANBUL_15TH = new Date('2026-09-14T21:30:00.000Z');

  it('accepts both ends empty for every urgency', () => {
    for (const urgency of ['TODAY', 'THIS_WEEK', 'FLEXIBLE', null, 'ASAP']) {
      expect(
        normalizePreferredDateRange(
          { preferredDate: null, preferredDateEnd: null, urgency },
          ISTANBUL_15TH,
        ),
      ).toEqual({ preferredDate: null, preferredDateEnd: null });
    }
  });

  it('stores the two days at UTC midnight, the legacy representation', () => {
    expect(
      normalizePreferredDateRange(
        { preferredDate: '2026-09-15', preferredDateEnd: '2026-09-20', urgency: 'FLEXIBLE' },
        ISTANBUL_15TH,
      ),
    ).toEqual({
      preferredDate: new Date('2026-09-15T00:00:00.000Z'),
      preferredDateEnd: new Date('2026-09-20T00:00:00.000Z'),
    });
  });

  it('uses the Istanbul day as "today" — the 15th is not the past at 21:30 UTC on the 14th', () => {
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-15', preferredDateEnd: '2026-09-15', urgency: 'TODAY' },
        ISTANBUL_15TH,
      ),
    ).not.toThrow();
    // ...and the 14th, still today in UTC, is yesterday for the customer.
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-14', preferredDateEnd: '2026-09-14', urgency: null },
        ISTANBUL_15TH,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.past);
  });

  it('refuses a half-given range', () => {
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-15', preferredDateEnd: null, urgency: null },
        ISTANBUL_15TH,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.incomplete);
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: null, preferredDateEnd: '2026-09-15', urgency: null },
        ISTANBUL_15TH,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.incomplete);
  });

  it('refuses anything that is not a real calendar day', () => {
    for (const bad of ['15.09.2026', '2026-09-15T00:00:00Z', '2026-02-30', 'bugün', '2026-9-5']) {
      expect(() =>
        normalizePreferredDateRange(
          { preferredDate: bad, preferredDateEnd: '2026-09-20', urgency: null },
          ISTANBUL_15TH,
        ),
      ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.invalid);
    }
  });

  it('refuses a reversed range', () => {
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-20', preferredDateEnd: '2026-09-15', urgency: null },
        ISTANBUL_15TH,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.reversed);
  });

  it('holds "Bugün" to today on both ends', () => {
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-15', preferredDateEnd: '2026-09-16', urgency: 'TODAY' },
        ISTANBUL_15TH,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.todayMismatch);
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-16', preferredDateEnd: '2026-09-16', urgency: 'TODAY' },
        ISTANBUL_15TH,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.todayMismatch);
  });

  it('holds "Bu hafta" to this week\'s Sunday', () => {
    // 15 September 2026 is a Tuesday; the week ends Sunday the 20th.
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-17', preferredDateEnd: '2026-09-20', urgency: 'THIS_WEEK' },
        ISTANBUL_15TH,
      ),
    ).not.toThrow();
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-17', preferredDateEnd: '2026-09-21', urgency: 'THIS_WEEK' },
        ISTANBUL_15TH,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.thisWeekMismatch);
  });

  it('on a Sunday, "Bu hafta" is that one day', () => {
    // 20 September 2026 is a Sunday: 21:30 UTC on the 19th is already Sunday in Istanbul.
    const sunday = new Date('2026-09-19T21:30:00.000Z');
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-20', preferredDateEnd: '2026-09-20', urgency: 'THIS_WEEK' },
        sunday,
      ),
    ).not.toThrow();
    expect(() =>
      normalizePreferredDateRange(
        { preferredDate: '2026-09-20', preferredDateEnd: '2026-09-21', urgency: 'THIS_WEEK' },
        sunday,
      ),
    ).toThrow(PREFERRED_DATE_RANGE_MESSAGES.thisWeekMismatch);
  });

  it('lets "Esnek" and legacy codes pick any valid future range', () => {
    for (const urgency of ['FLEXIBLE', null, 'ASAP', 'THIS_MONTH']) {
      expect(() =>
        normalizePreferredDateRange(
          { preferredDate: '2026-10-01', preferredDateEnd: '2027-01-15', urgency },
          ISTANBUL_15TH,
        ),
      ).not.toThrow();
    }
  });
});

// ── Over HTTP, with the production ValidationPipe ─────────────────────────────

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
});

describe('POST /service-requests preferred date range', () => {
  it('stores a range and reads it back on the customer projection', async () => {
    const category = await createCategory(ctx.prisma, 'Tarih aralığı', { offerCreditCost: 1 });
    const today = todayIsoDay(new Date());
    const end = addIsoDays(today, 3);

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          urgency: 'FLEXIBLE',
          preferredDate: today,
          preferredDateEnd: end,
        }),
      )
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: response.body.id },
      select: { preferredDate: true, preferredDateEnd: true },
    });
    expect(stored.preferredDate?.toISOString()).toBe(`${today}T00:00:00.000Z`);
    expect(stored.preferredDateEnd?.toISOString()).toBe(`${end}T00:00:00.000Z`);
    expect(response.body.preferredDateEnd).toBe(`${end}T00:00:00.000Z`);
  });

  it('accepts "Bugün" with both ends today, and refuses it otherwise', async () => {
    const category = await createCategory(ctx.prisma, 'Bugün', { offerCreditCost: 1 });
    const today = todayIsoDay(new Date());

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          urgency: 'TODAY',
          preferredDate: today,
          preferredDateEnd: today,
        }),
      )
      .expect(201);

    const refused = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          urgency: 'TODAY',
          preferredDate: today,
          preferredDateEnd: addIsoDays(today, 1),
        }),
      )
      .expect(400);
    expect(String(refused.body.message)).toContain(PREFERRED_DATE_RANGE_MESSAGES.todayMismatch);
    expect(await ctx.prisma.serviceRequest.count()).toBe(1);
  });

  it('accepts "Bu hafta" up to Sunday and refuses a later end', async () => {
    const category = await createCategory(ctx.prisma, 'Bu hafta', { offerCreditCost: 1 });
    const today = todayIsoDay(new Date());
    const sunday = endOfWeekIsoDay(today);

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          urgency: 'THIS_WEEK',
          preferredDate: today,
          preferredDateEnd: sunday,
        }),
      )
      .expect(201);

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          urgency: 'THIS_WEEK',
          preferredDate: today,
          preferredDateEnd: addIsoDays(sunday, 1),
        }),
      )
      .expect(400);
  });

  it('refuses the past, a reversed range, a half range and a malformed day', async () => {
    const category = await createCategory(ctx.prisma, 'Ret', { offerCreditCost: 1 });
    const today = todayIsoDay(new Date());

    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { preferredDate: addIsoDays(today, -1), preferredDateEnd: today },
        PREFERRED_DATE_RANGE_MESSAGES.past,
      ],
      [
        { preferredDate: addIsoDays(today, 5), preferredDateEnd: addIsoDays(today, 2) },
        PREFERRED_DATE_RANGE_MESSAGES.reversed,
      ],
      [{ preferredDate: today, preferredDateEnd: null }, PREFERRED_DATE_RANGE_MESSAGES.incomplete],
      [{ preferredDate: null, preferredDateEnd: today }, PREFERRED_DATE_RANGE_MESSAGES.incomplete],
      [
        { preferredDate: '15.09.2026', preferredDateEnd: today },
        PREFERRED_DATE_RANGE_MESSAGES.invalid,
      ],
      [
        { preferredDate: `${today}T00:00:00Z`, preferredDateEnd: today },
        PREFERRED_DATE_RANGE_MESSAGES.invalid,
      ],
    ];

    for (const [overrides, message] of cases) {
      // Six posts from one address would trip the per-IP budget mid-case.
      resetAuthThrottle(ctx.app);
      const response = await request(ctx.server)
        .post('/service-requests')
        .send(serviceRequestPayload(category.slug, { urgency: 'FLEXIBLE', ...overrides }))
        .expect(400);
      expect(String(response.body.message)).toContain(message);
    }
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('keeps a request with no dates legal, whatever the urgency', async () => {
    const category = await createCategory(ctx.prisma, 'Tarihsiz', { offerCreditCost: 1 });

    for (const urgency of ['TODAY', 'THIS_WEEK', 'FLEXIBLE', undefined]) {
      const response = await request(ctx.server)
        .post('/service-requests')
        .send(serviceRequestPayload(category.slug, urgency ? { urgency } : {}))
        .expect(201);
      expect(response.body.preferredDate).toBeNull();
      expect(response.body.preferredDateEnd).toBeNull();
    }
  });
});
