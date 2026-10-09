import {
  AdminPermission,
  CustomerOrigin,
  OfferEntitlementSource,
  OfferStatus,
  PrismaClient,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomersService } from '../src/modules/customers/customers.service';
import { OffersService } from '../src/modules/offers/offers.service';
import { SEARCH_PROJECTION_OMIT, type PrismaService } from '../src/prisma/prisma.service';
import {
  createAdminWithPermissions,
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
import { resolveTestDatabaseUrl } from './test-database';

/**
 * ADMIN-SEARCH-PAGINATION-001: `/customers` and `/offers` are paged by the
 * database.
 *
 * Both lists used to read every matching row: the customer list sorted all of
 * them in the process and sliced a page off, the offer list returned them all
 * and the screen cut the page (and applied the refund filter) itself. Now the
 * database counts the match and returns one page of it. What is asserted:
 * the pages tile the match with no gap and no repeat, in an order that is
 * stable across ties; every filter, sort and search applies before the page is
 * cut; the refund filter and the screen's figures are counted by the query;
 * a contact field the caller may not read still finds nothing; and no
 * statement reads the list unbounded. Nothing is timed.
 */

let ctx: TestContext;
/** A second client on the same database that records the SQL it sends. */
let logged: PrismaClient<{ omit: typeof SEARCH_PROJECTION_OMIT; log: [{ emit: 'event'; level: 'query' }] }>;
let statements: Array<{ query: string; params: string }> = [];

beforeAll(async () => {
  ctx = await createTestApp();
  logged = new PrismaClient({
    datasources: { db: { url: resolveTestDatabaseUrl() } },
    omit: SEARCH_PROJECTION_OMIT,
    log: [{ emit: 'event', level: 'query' }],
  });
  logged.$on('query', (event) => statements.push({ query: event.query, params: event.params }));
});

afterAll(async () => {
  await logged.$disconnect();
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  statements = [];
});

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

async function superAdmin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, user.id);
}

async function get(path: string, cookie: string) {
  const response = await request(ctx.server).get(path).set('Cookie', cookie);
  expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function status(path: string, cookie: string) {
  return (await request(ctx.server).get(path).set('Cookie', cookie)).status;
}

type Row = { id: string };
type Page<T = Row> = { items: T[]; total: number; page: number; pageSize: number; totalPages: number; hasNextPage: boolean };

/** Every page of a list, in order, with each page's own envelope checked. */
async function walk<T extends Row>(path: string, cookie: string, pageSize: number): Promise<{ ids: string[]; pages: Page<T>[] }> {
  const pages: Page<T>[] = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const body = (await get(`${path}${sep}page=${page}&pageSize=${pageSize}`, cookie)) as Page<T>;
    expect(body.page).toBe(page);
    expect(body.pageSize).toBe(pageSize);
    expect(body.totalPages).toBe(Math.ceil(body.total / pageSize));
    expect(body.hasNextPage).toBe(page * pageSize < body.total);
    expect(body.items.length).toBe(Math.max(0, Math.min(pageSize, body.total - (page - 1) * pageSize)));
    pages.push(body);
    if (!body.hasNextPage) break;
  }
  const ids = pages.flatMap((page) => page.items.map((item) => item.id));
  expect(new Set(ids).size, 'no row on two pages').toBe(ids.length);
  expect(ids.length, 'every row on some page').toBe(pages[0]!.total);
  return { ids, pages };
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const q = (value: string) => `q=${encodeURIComponent(value)}`;

describe('GET /customers — database pages', () => {
  it('tiles the match with no gap or repeat, breaking ties by id in either direction', async () => {
    const tied = new Date('2026-01-02T03:04:05.006Z');
    const created = [];
    for (let i = 0; i < 23; i += 1) {
      created.push(await createUser(ctx.prisma, { role: UserRole.CUSTOMER }));
    }
    await ctx.prisma.user.updateMany({ where: { role: UserRole.CUSTOMER }, data: { createdAt: tied } });
    const cookie = await superAdmin();
    const ascendingIds = created.map((user) => user.id).sort(byteOrder);

    for (const sort of ['sortBy=createdAt&sortDir=desc', 'sortBy=createdAt&sortDir=asc', 'sortBy=lastRequestAt']) {
      const { ids, pages } = await walk(`/customers?${sort}`, cookie, 10);
      expect(pages.map((page) => page.items.length), sort).toEqual([10, 10, 3]);
      expect(ids, sort).toEqual(ascendingIds);
    }
  });

  it('answers a page past the last one with no rows and the real total', async () => {
    for (let i = 0; i < 3; i += 1) await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const body = await get('/customers?page=5&pageSize=2', await superAdmin());
    expect(body).toMatchObject({ items: [], total: 3, page: 5, pageSize: 2, totalPages: 2, hasNextPage: false });
  });

  it('refuses a page or a size outside the contract', async () => {
    const cookie = await superAdmin();
    for (const bad of ['page=0', 'page=-1', 'page=abc', 'page=1000001', 'page=1.5', 'pageSize=0', 'pageSize=101']) {
      expect(await status(`/customers?${bad}`, cookie), bad).toBe(400);
    }
  });

  it('sorts names the Turkish way, and nameless accounts as the empty name', async () => {
    const names = ['Zeynep', 'Çağrı', 'Cem', 'Ömer', 'Oğuz', 'İpek', 'Irmak', 'Işık', 'ılgın', 'can', null, 'Şule', 'Sinan'];
    const created = [];
    for (const name of names) created.push(await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name }));
    const cookie = await superAdmin();
    const ordered = [...created].sort(
      (a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'tr') || byteOrder(a.id, b.id),
    );

    expect((await walk('/customers?sortBy=name&sortDir=asc', cookie, 4)).ids).toEqual(ordered.map((user) => user.id));
    const descending = [...created].sort(
      (a, b) => (b.name ?? '').localeCompare(a.name ?? '', 'tr') || byteOrder(a.id, b.id),
    );
    expect((await walk('/customers?sortBy=name&sortDir=desc', cookie, 4)).ids).toEqual(descending.map((user) => user.id));
  });

  it('sorts by the request and offer figures across pages', async () => {
    const category = await createCategory(ctx.prisma);
    const providers = await Promise.all([0, 1, 2].map(() => createProviderProfile(ctx.prisma)));
    // requests per customer, and how many of each one's offers are accepted
    const shape = [
      { requests: 0, offers: 0, accepted: 0 },
      { requests: 2, offers: 3, accepted: 1 },
      { requests: 1, offers: 1, accepted: 0 },
      { requests: 3, offers: 0, accepted: 0 },
      { requests: 2, offers: 2, accepted: 2 },
      { requests: 0, offers: 0, accepted: 0 },
    ];
    const customers: Array<{ id: string; requests: number; offers: number; accepted: number; last: Date | null }> = [];
    for (const [index, figures] of shape.entries()) {
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
      let last: Date | null = null;
      const requestIds: string[] = [];
      for (let r = 0; r < figures.requests; r += 1) {
        const submittedAt = new Date(Date.UTC(2026, 0, 1 + index * 3 + r));
        last = submittedAt;
        requestIds.push(
          (await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id, submittedAt })).id,
        );
      }
      // One accepted offer per request at most (the database's own rule).
      for (let o = 0; o < figures.offers; o += 1) {
        await ctx.prisma.offer.create({
          data: {
            requestId: requestIds[o % requestIds.length]!,
            providerId: providers[o]!.id,
            status: o < figures.accepted ? OfferStatus.ACCEPTED : OfferStatus.SUBMITTED,
            priceAmount: 1000,
            message: 'x',
            creditCost: 0,
          },
        });
      }
      customers.push({ id: customer.id, ...figures, last });
    }
    const cookie = await superAdmin();
    const order = (key: (c: (typeof customers)[number]) => number, dir: 1 | -1) =>
      [...customers].sort((a, b) => (key(a) - key(b)) * dir || byteOrder(a.id, b.id)).map((c) => c.id);
    const lastKey = (c: (typeof customers)[number]) => (c.last ? c.last.getTime() : Number.NEGATIVE_INFINITY);

    expect((await walk('/customers?sortBy=requestCount&sortDir=desc', cookie, 4)).ids).toEqual(order((c) => c.requests, -1));
    expect((await walk('/customers?sortBy=offerCount&sortDir=asc', cookie, 4)).ids).toEqual(order((c) => c.offers, 1));
    expect((await walk('/customers?sortBy=acceptedOfferCount&sortDir=desc', cookie, 4)).ids).toEqual(
      order((c) => c.accepted, -1),
    );
    // No request sorts below every date: first ascending, last descending.
    expect((await walk('/customers?sortBy=lastRequestAt&sortDir=asc', cookie, 4)).ids).toEqual(order(lastKey, 1));
    expect((await walk('/customers?sortBy=lastRequestAt&sortDir=desc', cookie, 4)).ids).toEqual(order(lastKey, -1));

    // The figures on each row are that customer's, whatever page it lands on.
    const { pages } = await walk<Row & { requestCount: number; offerCount: number; acceptedOfferCount: number }>(
      '/customers?sortBy=requestCount',
      cookie,
      4,
    );
    for (const row of pages.flatMap((page) => page.items)) {
      const expected = customers.find((c) => c.id === row.id)!;
      expect([row.requestCount, row.offerCount, row.acceptedOfferCount]).toEqual([
        expected.requests,
        expected.offers,
        expected.accepted,
      ]);
    }
  });

  it('filters by city, last-request range and origin before it pages', async () => {
    const category = await createCategory(ctx.prisma);
    const make = async (city: string, submittedAt: Date, origin: CustomerOrigin) => {
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, customerOrigin: origin });
      await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id, city, submittedAt });
      return customer.id;
    };
    const inside = [];
    for (let i = 0; i < 5; i += 1) {
      inside.push(await make('İzmir', new Date(Date.UTC(2026, 2, 10 + i)), CustomerOrigin.REGISTERED));
    }
    await make('Ankara', new Date(Date.UTC(2026, 2, 12)), CustomerOrigin.REGISTERED);
    await make('İzmir', new Date(Date.UTC(2026, 4, 1)), CustomerOrigin.REGISTERED);
    await make('İzmir', new Date(Date.UTC(2026, 2, 12)), CustomerOrigin.IMPORTED);
    const cookie = await superAdmin();

    const filter = `city=${encodeURIComponent('İzmir')}&lastRequestFrom=2026-03-01T00:00:00.000Z&lastRequestTo=2026-03-31T23:59:59.999Z&customerOrigin=REGISTERED`;
    const { ids, pages } = await walk(`/customers?${filter}&sortBy=lastRequestAt&sortDir=asc`, cookie, 2);
    expect(pages[0]!.total).toBe(5);
    expect(ids).toEqual(inside);
  });

  it('keeps the Turkish, e-mail and phone search on every page', async () => {
    const matches = [];
    for (const name of ['IŞIK Bir', 'Işık İki', 'ışık üç']) {
      matches.push((await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name })).id);
    }
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Başka' });
    const ivan = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Ivan Petrov', email: 'ivan.p@example.test' });
    const phone = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Telefonlu', phone: '+905551234567' });
    const cookie = await superAdmin();

    const turkish = await walk(`/customers?${q('ışık')}&sortBy=name&sortDir=asc`, cookie, 1);
    expect([...turkish.ids].sort()).toEqual([...matches].sort());
    expect((await walk(`/customers?${q('IVAN.P@')}`, cookie, 1)).ids).toEqual([ivan.id]);
    for (const box of ['0555 123 45 67', '+90 555 123 45 67', '5551234']) {
      expect((await walk(`/customers?${q(box)}`, cookie, 1)).ids, box).toEqual([phone.id]);
    }
  });

  it('leaves the figures out, and refuses their sorts and filters, without their permissions', async () => {
    for (let i = 0; i < 3; i += 1) await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await sessionWith([AdminPermission.CUSTOMERS_READ]);

    const { pages } = await walk<Record<string, unknown> & Row>('/customers', cookie, 2);
    for (const row of pages.flatMap((page) => page.items)) {
      for (const hidden of ['requestCount', 'lastRequestAt', 'lastRequestCity', 'offerCount', 'acceptedOfferCount']) {
        expect(row, hidden).not.toHaveProperty(hidden);
      }
    }
    expect(pages[0]).not.toHaveProperty('meta.anonymousRequestCount');
    for (const refused of ['sortBy=requestCount', 'sortBy=lastRequestAt', 'sortBy=offerCount', 'city=Izmir']) {
      expect(await status(`/customers?${refused}`, cookie), refused).toBe(403);
    }
  });
});

/** One provider's offers on `count` requests, all submitted at the same instant unless told otherwise. */
async function offersOnRequests(count: number, at = new Date('2026-02-03T04:05:06.007Z')) {
  const category = await createCategory(ctx.prisma);
  const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
  const offers = [];
  for (let i = 0; i < count; i += 1) {
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    offers.push(
      await ctx.prisma.offer.create({
        data: { requestId: req.id, providerId: provider.id, priceAmount: 1000, message: 'x', creditCost: 0, submittedAt: at },
      }),
    );
  }
  return { category, provider, offers };
}

describe('GET /offers — database pages', () => {
  it('returns one page, counts the whole match, and orders a tie by id', async () => {
    const { offers } = await offersOnRequests(12);
    const cookie = await superAdmin();

    const { ids, pages } = await walk('/offers', cookie, 5);
    expect(pages.map((page) => page.items.length)).toEqual([5, 5, 2]);
    expect(ids).toEqual(offers.map((offer) => offer.id).sort(byteOrder).reverse());

    // The default page is the screen's 50.
    const first = await get('/offers', cookie);
    expect(first).toMatchObject({ total: 12, page: 1, pageSize: 50, totalPages: 1, hasNextPage: false });
    expect(await get('/offers?page=9&pageSize=5', cookie)).toMatchObject({ items: [], total: 12, hasNextPage: false });
  });

  it('newest first across pages', async () => {
    const { offers } = await offersOnRequests(7);
    for (const [i, offer] of offers.entries()) {
      await ctx.prisma.offer.update({ where: { id: offer.id }, data: { submittedAt: new Date(Date.UTC(2026, 0, 1 + ((i * 3) % 7))) } });
    }
    const stored = await ctx.prisma.offer.findMany({ select: { id: true, submittedAt: true } });
    const expected = stored
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime() || byteOrder(b.id, a.id))
      .map((offer) => offer.id);
    expect((await walk('/offers', await superAdmin(), 3)).ids).toEqual(expected);
  });

  it('refuses a page, a size or a refund filter outside the contract', async () => {
    const cookie = await superAdmin();
    for (const bad of ['page=0', 'page=x', 'page=1000001', 'pageSize=0', 'pageSize=101', 'refundAction=MAYBE', 'refundAction=all']) {
      expect(await status(`/offers?${bad}`, cookie), bad).toBe(400);
    }
  });

  it('filters by the refund verdict in the query, and counts the screen figures over the match', async () => {
    const { offers } = await offersOnRequests(8, new Date(Date.UTC(2026, 0, 5)));
    const past = new Date(Date.UTC(2026, 0, 7));
    const future = new Date(Date.now() + 86_400_000);
    const inPolicy = { unviewedRefundPolicy: true, unviewedRefundWindowHours: 48, creditCost: 1, creditSpentTransactionId: 'spent' };
    const set = (i: number, data: Record<string, unknown>) =>
      ctx.prisma.offer.update({ where: { id: offers[i]!.id }, data: data as never });
    await set(0, { ...inPolicy, unviewedRefundEligibleAt: past }); // FULL_REFUND
    await set(1, { ...inPolicy, unviewedRefundEligibleAt: past, creditSpentTransactionId: 'spent-2' }); // FULL_REFUND
    await set(2, { ...inPolicy, unviewedRefundEligibleAt: null }); // NO_REFUND_SCHEDULE: a NULL that must land somewhere
    await set(3, { ...inPolicy, unviewedRefundEligibleAt: past, viewedAt: past, status: OfferStatus.VIEWED }); // VIEWED
    await set(4, { ...inPolicy, unviewedRefundEligibleAt: future }); // still waiting
    await set(5, { ...inPolicy, unviewedRefundEligibleAt: past, entitlementSource: OfferEntitlementSource.MONTHLY_QUOTA });
    await set(6, { ...inPolicy, unviewedRefundEligibleAt: past, refundBlockedAt: past });
    // 7: outside the policy, SUBMITTED and never opened.
    const cookie = await superAdmin();

    const full = await get('/offers?refundAction=FULL_REFUND', cookie);
    expect(full.items.map((o: Row) => o.id).sort()).toEqual([offers[0]!.id, offers[1]!.id].sort());
    expect(full.total).toBe(2);
    const none = await walk<Row & { refundEligibility: { recommendedAction: string } }>(
      '/offers?refundAction=NO_REFUND',
      cookie,
      2,
    );
    expect(none.ids.sort()).toEqual(offers.slice(2).map((o) => o.id).sort());
    for (const row of [...full.items, ...none.pages.flatMap((page) => page.items)]) {
      const expected = full.items.includes(row) ? 'FULL_REFUND' : 'NO_REFUND';
      expect(row.refundEligibility.recommendedAction).toBe(expected);
    }

    // The figures count the match before the refund filter, whatever it is.
    const summary = { matching: 8, fullRefund: 2, viewed: 1, newUnviewed: 7 };
    for (const path of ['/offers', '/offers?refundAction=FULL_REFUND', '/offers?refundAction=NO_REFUND&page=3&pageSize=2']) {
      expect((await get(path, cookie)).summary, path).toEqual(summary);
    }
  });

  it('keeps the status, request, provider, category, city and date filters', async () => {
    const a = await offersOnRequests(3, new Date(Date.UTC(2026, 3, 10)));
    const b = await offersOnRequests(2, new Date(Date.UTC(2026, 5, 10)));
    await ctx.prisma.serviceRequest.update({ where: { id: b.offers[0]!.requestId }, data: { city: 'Iğdır' } });
    await ctx.prisma.offer.update({ where: { id: a.offers[1]!.id }, data: { status: OfferStatus.ACCEPTED } });
    const cookie = await superAdmin();
    const idsOf = async (path: string) => (await walk(path, cookie, 2)).ids.sort();

    expect(await idsOf('/offers?status=ACCEPTED')).toEqual([a.offers[1]!.id]);
    expect(await idsOf(`/offers?providerId=${b.provider.id}`)).toEqual(b.offers.map((o) => o.id).sort());
    expect(await idsOf(`/offers?requestId=${a.offers[2]!.requestId}`)).toEqual([a.offers[2]!.id]);
    expect(await idsOf(`/offers?categorySlug=${a.category.slug}`)).toEqual(a.offers.map((o) => o.id).sort());
    expect(await idsOf(`/offers?city=${encodeURIComponent('Iğdır')}`)).toEqual([b.offers[0]!.id]);
    expect(
      await idsOf('/offers?submittedFrom=2026-04-01T00:00:00.000Z&submittedTo=2026-04-30T23:59:59.999Z'),
    ).toEqual(a.offers.map((o) => o.id).sort());
  });
});

describe('GET /offers — a contact field the caller may not read finds nothing, on any page', () => {
  async function contactWorld() {
    const { provider, offers } = await offersOnRequests(3);
    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { contactName: 'Gizli Yetkili', phone: '+905321112233', email: 'gizli.hv@example.test' },
    });
    await ctx.prisma.serviceRequest.updateMany({
      where: { id: { in: offers.map((o) => o.requestId) } },
      data: { customerName: 'Saklı Müşteri', customerPhone: '+905557778899', customerEmail: 'sakli@example.test' },
    });
    return offers;
  }
  // The provider's e-mail is not searched at all, for any reader.
  const providerBoxes = ['gizli yetkili', '0532 111 22 33'];
  const requestBoxes = ['saklı müşteri', '0555 777 88 99', 'sakli@example'];

  it('OFFERS_READ alone: no hit, no count, no hidden field', async () => {
    await contactWorld();
    const cookie = await sessionWith([AdminPermission.OFFERS_READ]);
    for (const box of [...providerBoxes, ...requestBoxes]) {
      const body = await get(`/offers?${q(box)}`, cookie);
      expect(body.items, box).toEqual([]);
      expect(body.total, box).toBe(0);
      expect(body.summary, box).toEqual({ matching: 0, fullRefund: 0, viewed: 0, newUnviewed: 0 });
    }
    for (const row of (await get('/offers?pageSize=2', cookie)).items) {
      for (const hidden of ['contactName', 'phone', 'email']) expect(row.provider, hidden).not.toHaveProperty(hidden);
      for (const hidden of ['customerName', 'customerPhone', 'customerEmail', 'customer']) {
        expect(row.request, hidden).not.toHaveProperty(hidden);
      }
    }
  });

  it('with the permission, the same boxes find the offers, page by page', async () => {
    const offers = await contactWorld();
    const all = offers.map((o) => o.id).sort();
    const providerReader = await sessionWith([AdminPermission.OFFERS_READ, AdminPermission.PROVIDERS_READ]);
    const requestReader = await sessionWith([AdminPermission.OFFERS_READ, AdminPermission.REQUESTS_READ]);
    for (const box of providerBoxes) {
      expect((await walk(`/offers?${q(box)}`, providerReader, 2)).ids.sort(), box).toEqual(all);
      expect((await get(`/offers?${q(box)}`, requestReader)).total, box).toBe(0);
    }
    for (const box of requestBoxes) {
      expect((await walk(`/offers?${q(box)}`, requestReader, 2)).ids.sort(), box).toEqual(all);
      expect((await get(`/offers?${q(box)}`, providerReader)).total, box).toBe(0);
    }
  });
});

describe('no unbounded read', () => {
  const superViewer = { id: 'viewer', role: UserRole.SUPER_ADMIN, permissions: [] } as never;
  const rowsRead = (table: string) =>
    statements.filter(
      (s) =>
        new RegExp(`FROM "(public"\\.")?${table}"`).test(s.query) &&
        /^\s*SELECT/i.test(s.query) &&
        !/^\s*SELECT COUNT\(/i.test(s.query),
    );

  it('the customer list reads one page of customers and the figures of that page only', async () => {
    for (let i = 0; i < 12; i += 1) await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const service = new CustomersService(logged as unknown as PrismaService);
    statements = [];
    const res = await service.list({ page: 2, pageSize: 5, sortBy: 'requestCount' } as never, superViewer);
    expect(res.items).toHaveLength(5);

    const pageQuery = statements.filter((s) => /^SELECT u\."id" FROM "User" u/.test(s.query));
    expect(pageQuery).toHaveLength(1);
    expect(pageQuery[0]!.query).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(JSON.parse(pageQuery[0]!.params).slice(-2)).toEqual([5, 5]);
    // Every other read of the customers is keyed by the page's ids.
    for (const statement of rowsRead('User').filter((s) => s !== pageQuery[0])) {
      expect(statement.query).toMatch(/"id" IN \(/);
      expect(JSON.parse(statement.params).length).toBeLessThanOrEqual(5 + 1);
    }
    for (const statement of statements.filter((s) => /"customerId" IN \(/.test(s.query))) {
      expect(JSON.parse(statement.params).length).toBeLessThanOrEqual(5 + 1);
    }
  });

  it('the offer list reads one page of offers and the relations of that page only', async () => {
    await offersOnRequests(12);
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    statements = [];
    const res = await service.listOffers({ page: 2, pageSize: 5 }, superViewer);
    expect(res.items).toHaveLength(5);

    const offerRows = rowsRead('Offer');
    expect(offerRows).toHaveLength(1);
    expect(offerRows[0]!.query).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(JSON.parse(offerRows[0]!.params).slice(-2)).toEqual([5, 5]);
    for (const table of ['ProviderProfile', 'ServiceRequest']) {
      for (const statement of rowsRead(table)) {
        expect(statement.query, table).toMatch(/ IN \(/);
        expect(JSON.parse(statement.params).length, table).toBeLessThanOrEqual(5 + 2);
      }
    }
  });
});

/** The plan's node types and index names, flattened. */
function planNodes(node: Record<string, unknown>, out: string[] = []): string[] {
  out.push(String(node['Node Type']));
  if (node['Index Name']) out.push(String(node['Index Name']));
  for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) planNodes(child, out);
  return out;
}

/**
 * The plan PostgreSQL makes for a recorded statement when it may only use
 * bitmap index scans. Seq Scan stays possible as the planner's last resort, so
 * a plan without one on "User" proves every arm of the search has an index.
 */
async function bitmapOnlyPlan(statement: { query: string; params: string }): Promise<string[]> {
  return ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_indexonlyscan = off');
    const [row] = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>>(
      `EXPLAIN (FORMAT JSON) ${statement.query}`,
      ...(JSON.parse(statement.params) as unknown[]),
    );
    return planNodes(row!['QUERY PLAN'][0]!.Plan);
  });
}

describe('the customer search is index-backed', () => {
  it('answers the count and the page with a BitmapOr of the trigram indexes, for text and phone boxes', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Işık Müşteri', phone: '+905551234567' });
    // Enough customers that the role filter selects nearly every row, as it
    // does in production; on a near-empty table the role index alone wins.
    await ctx.prisma.user.createMany({
      data: Array.from({ length: 20_000 }, (_, i) => ({
        role: UserRole.CUSTOMER,
        name: `Müşteri ${i}`,
        email: `m${i}@ornek.test`,
        phone: `+90532${String(i).padStart(7, '0')}`,
      })),
    });
    // VACUUM merges the GIN pending list the bulk insert left behind, as an
    // index built by CREATE INDEX has none; ANALYZE gives the planner the counts.
    await ctx.prisma.$executeRawUnsafe('VACUUM ANALYZE "User"');
    const service = new CustomersService(logged as unknown as PrismaService);
    // CUSTOMERS_READ only: no request figure is joined, so the plan is the User search alone.
    const viewer = { id: 'viewer', role: UserRole.ADMIN, permissions: [AdminPermission.CUSTOMERS_READ] } as never;

    for (const box of ['ışık', 'example.test', '0555 123 45 67']) {
      statements = [];
      await service.list({ q: box, page: 1, pageSize: 20 } as never, viewer);
      const userStatements = statements.filter((s) => /FROM "User" u/.test(s.query));
      expect(userStatements, box).toHaveLength(2);
      for (const statement of userStatements) {
        const plan = await bitmapOnlyPlan(statement);
        expect(plan, box).toContain('BitmapOr');
        expect(plan, box).not.toContain('Seq Scan');
        for (const index of ['User_name_trgm_idx', 'User_nameSearch_trgm_idx', 'User_email_trgm_idx', 'User_phone_trgm_idx']) {
          expect(plan, `${box}: ${index}`).toContain(index);
        }
      }
    }
  });
});
