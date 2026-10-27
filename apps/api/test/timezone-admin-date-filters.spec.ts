import { BadRequestException } from '@nestjs/common';
import { ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAdminDateRange } from '../src/common/admin-date-range';
import {
  createApprovedRequest,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * TIMEZONE-001: an admin list's `YYYY-MM-DD` filter is the whole Istanbul day.
 *
 * The admin screens send what a date input holds. The API used to read
 * `2026-10-27` as `new Date('2026-10-27')` — UTC midnight, 03:00 in Istanbul —
 * so every window was three hours late, and `from = to` matched a single
 * millisecond. A day is now [its Istanbul 00:00, the next day's Istanbul 00:00).
 *
 * Every fixture sits on an edge the old reading got wrong: just before and
 * just after Istanbul midnight, which is 21:00 UTC the evening before.
 */

describe('parseAdminDateRange', () => {
  const hostZone = process.env.TZ;
  afterEach(() => {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  });

  it('reads a one-day filter as that Istanbul day, end exclusive', () => {
    expect(parseAdminDateRange('2026-10-27', '2026-10-27', 'from', 'to')).toEqual({
      gte: new Date('2026-10-26T21:00:00.000Z'),
      lt: new Date('2026-10-27T21:00:00.000Z'),
    });
  });

  it('closes a range at the next day, across a month and a year end', () => {
    expect(parseAdminDateRange('2026-10-01', '2026-10-31', 'from', 'to')).toEqual({
      gte: new Date('2026-09-30T21:00:00.000Z'),
      lt: new Date('2026-10-31T21:00:00.000Z'),
    });
    expect(parseAdminDateRange(undefined, '2026-12-31', 'from', 'to')).toEqual({
      lt: new Date('2026-12-31T21:00:00.000Z'),
    });
  });

  it('keeps a one-sided filter one-sided and an empty one absent', () => {
    expect(parseAdminDateRange('2026-10-27', undefined, 'from', 'to')).toEqual({
      gte: new Date('2026-10-26T21:00:00.000Z'),
    });
    expect(parseAdminDateRange(undefined, undefined, 'from', 'to')).toBeUndefined();
    expect(parseAdminDateRange('', '  ', 'from', 'to')).toBeUndefined();
  });

  it('still takes a full timestamp as the instant it names', () => {
    expect(parseAdminDateRange('2026-03-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z', 'from', 'to')).toEqual({
      gte: new Date('2026-03-01T00:00:00.000Z'),
      lte: new Date('2026-03-31T23:59:59.999Z'),
    });
  });

  it('refuses a reversed range and an unreadable end', () => {
    expect(() => parseAdminDateRange('2026-10-28', '2026-10-27', 'from', 'to')).toThrow(BadRequestException);
    expect(() => parseAdminDateRange('2026-10-28T00:00:00Z', '2026-10-27T00:00:00Z', 'from', 'to')).toThrow(
      '"from" must be on or before "to"',
    );
    expect(() => parseAdminDateRange('yarın', undefined, 'from', 'to')).toThrow('Invalid "from" date');
  });

  it('draws the same window in every host zone', () => {
    for (const zone of ['UTC', 'Europe/Istanbul', 'America/New_York', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      expect(parseAdminDateRange('2026-11-01', '2026-11-01', 'from', 'to'), zone).toEqual({
        gte: new Date('2026-10-31T21:00:00.000Z'),
        lt: new Date('2026-11-01T21:00:00.000Z'),
      });
    }
  });
});

let ctx: TestContext;

describe('admin list date filters over HTTP', () => {
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

  /** The edges of 27 October 2026 in Istanbul, and one step outside each. */
  const BEFORE = new Date('2026-10-26T20:59:59.999Z'); // 26 Oct 23:59:59.999 Istanbul
  const FIRST = new Date('2026-10-26T21:00:00.000Z'); // 27 Oct 00:00 Istanbul
  const EARLY = new Date('2026-10-26T23:30:00.000Z'); // 27 Oct 02:30 — UTC still says the 26th
  const LAST = new Date('2026-10-27T20:59:59.999Z'); // 27 Oct 23:59:59.999 Istanbul
  const AFTER = new Date('2026-10-27T21:00:00.000Z'); // 28 Oct 00:00 Istanbul

  async function superAdmin() {
    const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await ctx.prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
    return loginAs(ctx.prisma, user.id);
  }

  async function ids(path: string, cookie: string): Promise<string[]> {
    const response = await request(ctx.server).get(path).set('Cookie', cookie);
    expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
    return (response.body.items as Array<{ id: string }>).map((item) => item.id).sort();
  }

  const sorted = (values: string[]) => [...values].sort();

  it('GET /users: createdFrom = createdTo is the whole Istanbul day', async () => {
    const cookie = await superAdmin();
    const at = async (createdAt: Date) => {
      const user = await createUser(ctx.prisma, { role: UserRole.ADMIN });
      await ctx.prisma.user.update({ where: { id: user.id }, data: { createdAt } });
      return user.id;
    };
    await at(BEFORE);
    const inside = [await at(FIRST), await at(EARLY), await at(LAST)];
    await at(AFTER);

    expect(await ids('/users?createdFrom=2026-10-27&createdTo=2026-10-27', cookie)).toEqual(sorted(inside));
    // One-sided: from the 27th on includes the 28th, up to the 27th includes the 26th.
    expect((await ids('/users?createdFrom=2026-10-27', cookie)).length).toBe(4);
    expect((await ids('/users?createdTo=2026-10-27&createdFrom=2026-10-26', cookie)).length).toBe(4);
  });

  it('GET /users: a reversed day range is a 400, as before', async () => {
    const cookie = await superAdmin();
    const response = await request(ctx.server)
      .get('/users?createdFrom=2026-10-28&createdTo=2026-10-27')
      .set('Cookie', cookie);
    expect(response.status).toBe(400);
  });

  it('GET /customers: lastRequestFrom = lastRequestTo is the whole Istanbul day', async () => {
    const cookie = await superAdmin();
    const category = await createCategory(ctx.prisma);
    const at = async (submittedAt: Date) => {
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
      await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id, submittedAt });
      return customer.id;
    };
    await at(BEFORE);
    const inside = [await at(FIRST), await at(EARLY), await at(LAST)];
    await at(AFTER);

    expect(await ids('/customers?lastRequestFrom=2026-10-27&lastRequestTo=2026-10-27', cookie)).toEqual(
      sorted(inside),
    );
  });

  it('GET /offers: submittedFrom = submittedTo is the whole Istanbul day; a timestamp is still an instant', async () => {
    const cookie = await superAdmin();
    const category = await createCategory(ctx.prisma);
    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const at = async (submittedAt: Date) => {
      const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
      const offer = await ctx.prisma.offer.create({
        data: { requestId: req.id, providerId: provider.id, priceAmount: 1000, message: 'x', creditCost: 0, submittedAt },
      });
      return offer.id;
    };
    const before = await at(BEFORE);
    const inside = [await at(FIRST), await at(EARLY), await at(LAST)];
    await at(AFTER);

    expect(await ids('/offers?submittedFrom=2026-10-27&submittedTo=2026-10-27', cookie)).toEqual(sorted(inside));
    // The instant form keeps its meaning: exactly the window it names.
    expect(
      await ids(`/offers?submittedFrom=${BEFORE.toISOString()}&submittedTo=${BEFORE.toISOString()}`, cookie),
    ).toEqual([before]);
  });
});
