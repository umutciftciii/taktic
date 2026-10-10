import { AdminPermission, OfferStatus, Prisma, PrismaClient, ProviderStatus, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAdminTextSearch, type AdminTextSearch } from '../src/common/admin-search';
import {
  joinedOfferSearchWhere,
  OFFER_SEARCH_ID_LIST_LIMIT,
  resolveOfferSearchWhere,
  type OfferSearchScope,
} from '../src/modules/offers/offer-search';
import { OffersService } from '../src/modules/offers/offers.service';
import { viewedInPolicyWhere } from '../src/modules/offers/refund-policy';
import { SEARCH_PROJECTION_OMIT, type PrismaService } from '../src/prisma/prisma.service';
import { createApprovedRequest, createCategory, createTestApp, resetDatabase, type TestContext } from './harness';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * OFFERS-SEARCH-OPT-001: the offer search resolves its provider and request
 * matches to ids before it reads the offers.
 *
 * The list's search used to join the provider and the request to every offer
 * and OR their columns, in each of the list's five statements; no index can
 * serve an OR across three tables, so each statement read the whole offer
 * table. Now each table is asked once, on the list's own transaction, and the
 * offer statements filter by `id`/`providerId`/`requestId IN (…)`. What is
 * asserted: the statements have that shape and carry bounded lists; a table
 * that matches more than the bound keeps its join, and the answer is the same
 * either way; everything is read in one RepeatableRead snapshot; and a column
 * the caller may not read is not in any statement's condition. Nothing is timed.
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
  statements = [];
});

const P = AdminPermission;
const VIEWERS = {
  offersOnly: [P.OFFERS_READ],
  providerContact: [P.OFFERS_READ, P.PROVIDERS_READ],
  requestDetail: [P.OFFERS_READ, P.REQUESTS_READ],
  both: [P.OFFERS_READ, P.PROVIDERS_READ, P.REQUESTS_READ],
} as const;
type ViewerName = keyof typeof VIEWERS;
const viewer = (name: ViewerName) => ({ id: 'viewer', role: UserRole.ADMIN, permissions: [...VIEWERS[name]] }) as never;
const scopeOf = (name: ViewerName): OfferSearchScope => ({
  providerContact: (VIEWERS[name] as readonly AdminPermission[]).includes(P.PROVIDERS_READ),
  requestDetail: (VIEWERS[name] as readonly AdminPermission[]).includes(P.REQUESTS_READ),
});

const byNewest = [{ submittedAt: 'desc' }, { id: 'desc' }] satisfies Prisma.OfferOrderByWithRelationInput[];

async function searchOf(box: string): Promise<AdminTextSearch> {
  const search = await parseAdminTextSearch(ctx.prisma, box);
  if (!search) throw new Error(`blank box: ${box}`);
  return search;
}

/** Offer ids the joined (pre-OFFERS-SEARCH-OPT-001) shape matches, newest first. */
async function joinedIds(search: AdminTextSearch, scope: OfferSearchScope, filter: Prisma.OfferWhereInput = {}) {
  const rows = await ctx.prisma.offer.findMany({
    where: { AND: [filter, joinedOfferSearchWhere(search, scope)] },
    orderBy: byNewest,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Offer ids the resolved shape matches, resolved on its own RepeatableRead transaction. */
async function resolvedIds(search: AdminTextSearch, scope: OfferSearchScope, limit: number, filter: Prisma.OfferWhereInput = {}) {
  return ctx.prisma.$transaction(
    async (tx) => {
      const where = await resolveOfferSearchWhere(tx, search, scope, limit);
      const rows = await tx.offer.findMany({ where: { AND: [filter, where] }, orderBy: byNewest, select: { id: true } });
      return rows.map((row) => row.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/**
 * Providers and requests whose searchable columns hold every spelling the box
 * has to tell apart: Turkish dotted and dotless I in both cases, an ASCII-caps
 * name, phones stored E.164, with a leading zero and bare, e-mails, cities and
 * districts — and offers between them in every state the figures count.
 */
async function searchWorld() {
  const category = await createCategory(ctx.prisma);
  const providerRows = [
    { businessName: 'Işık Tesisat', contactName: 'Gizli Yetkili', phone: '+905321112233', email: 'gizli.hv@example.test' },
    { businessName: 'ISIK ELEKTRIK', contactName: 'İlker Şahin', phone: '+905329998877', email: 'ilker@example.test' },
    { businessName: 'Çağrı Boya', contactName: 'Ivan Petrov', phone: '+905324445566', email: 'ivan@example.test' },
    { businessName: 'Usta %_ Nakliyat', contactName: 'Işıl Kaya', phone: '+905327776655', email: 'isil@example.test' },
  ];
  const providers = [];
  for (const [i, row] of providerRows.entries()) {
    providers.push(
      await ctx.prisma.providerProfile.create({
        data: {
          ...row,
          taxType: 'SAHIS',
          taxNumber: `987654${i}000`,
          city: 'İstanbul',
          district: 'Kadıköy',
          status: ProviderStatus.APPROVED,
        },
      }),
    );
  }
  const requestRows = [
    { customerName: 'Saklı Müşteri', customerPhone: '+905557778899', customerEmail: 'Sakli@Example.test', city: 'Iğdır', district: 'Merkez' },
    { customerName: 'IŞIK YILMAZ', customerPhone: '05551234567', customerEmail: 'isik@example.test', city: 'İzmir', district: 'Karşıyaka' },
    { customerName: 'Ömer Işıkçı', customerPhone: '5559876543', customerEmail: null, city: 'ISPARTA', district: 'Eğirdir' },
    { customerName: 'Ivan Ivanov', customerPhone: '+905551112233', customerEmail: 'ivan.i@example.test', city: 'Ankara', district: 'Çankaya' },
    { customerName: 'Zeynep Demir', customerPhone: '05550001122', customerEmail: 'zeynep@example.test', city: 'İstanbul', district: 'Kadıköy' },
  ];
  const requests = [];
  for (const [i, row] of requestRows.entries()) {
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: row.city,
      district: row.district,
      customerPhone: row.customerPhone,
      customerEmail: row.customerEmail,
      submittedAt: new Date(Date.UTC(2026, 0, 1 + i)),
    });
    requests.push(
      await ctx.prisma.serviceRequest.update({ where: { id: created.id }, data: { customerName: row.customerName } }),
    );
  }

  const past = new Date(Date.UTC(2026, 0, 20));
  const inPolicy = { unviewedRefundPolicy: true, unviewedRefundWindowHours: 48, creditCost: 1 };
  const offers = [];
  let n = 0;
  for (const [r, req] of requests.entries()) {
    for (const [p, provider] of providers.entries()) {
      if ((r + p) % 3 === 2) continue;
      n += 1;
      const variant = n % 4;
      offers.push(
        await ctx.prisma.offer.create({
          data: {
            requestId: req.id,
            providerId: provider.id,
            priceAmount: 1000,
            message: 'x',
            creditCost: 0,
            // Every third offer shares an instant with the one before it, so the id breaks the tie.
            submittedAt: new Date(Date.UTC(2026, 0, 10, 0, 0, n - (n % 3 === 0 ? 1 : 0))),
            ...(variant === 0 ? { ...inPolicy, creditSpentTransactionId: `spent-${n}`, unviewedRefundEligibleAt: past } : {}),
            ...(variant === 1 ? { status: OfferStatus.VIEWED, viewedAt: past } : {}),
            ...(variant === 2 ? { ...inPolicy, status: OfferStatus.VIEWED, viewedAt: past, unviewedRefundEligibleAt: past } : {}),
            ...(variant === 3 ? { status: OfferStatus.ACCEPTED } : {}),
          },
        }),
      );
    }
  }
  await ctx.prisma.$executeRawUnsafe('ANALYZE "Offer", "ProviderProfile", "ServiceRequest"');
  return { category, providers, requests, offers };
}

/** Every box the search contract covers, beside the ids of the world it searches. */
function boxesFor(world: Awaited<ReturnType<typeof searchWorld>>) {
  const offerId = world.offers[3]!.id;
  const requestId = world.requests[1]!.id;
  const providerId = world.providers[2]!.id;
  return [
    'Işık', 'ışık', 'IŞIK', 'ISIK', 'isik', 'İLKER', 'ilker', 'ivan', 'IVAN',
    'tesisat', 'gizli yetkili', 'ışıl kaya',
    '0532 111 22 33', '+905321112233', '905321112233', '5321112',
    'saklı müşteri', 'SAKLI@EXAMPLE', 'sakli@example.test', '0555 123 45 67', '+905551234567', '5559876543', '555',
    'iğdır', 'IĞDIR', 'izmir', 'İZMİR', 'kadıköy', 'eğirdir', 'ısparta',
    offerId, offerId.slice(3, 12).toUpperCase(), requestId, requestId.slice(-8), providerId, providerId.slice(2, 10),
    '%', '_', 'zzqqxx', 'a', 'e',
  ];
}

describe('the resolved search finds what the joined one does', () => {
  it('for every box, every reader, with the lists in use and with every table on its join', async () => {
    const world = await searchWorld();
    const boxes = boxesFor(world);
    let nonEmpty = 0;
    for (const box of boxes) {
      const search = await searchOf(box);
      for (const name of Object.keys(VIEWERS) as ViewerName[]) {
        const scope = scopeOf(name);
        const expected = await joinedIds(search, scope);
        if (expected.length > 0) nonEmpty += 1;
        // OFFER_SEARCH_ID_LIST_LIMIT: the lists. 1 and 0: the tables that match more fall back to their joins.
        for (const limit of [OFFER_SEARCH_ID_LIST_LIMIT, 1, 0]) {
          expect(await resolvedIds(search, scope, limit), `${box} / ${name} / limit ${limit}`).toEqual(expected);
        }
      }
    }
    // The boxes are not vacuous: most of them find something for someone.
    expect(nonEmpty).toBeGreaterThan(boxes.length * 2);
  });

  it('with the status, request, provider, date and city filters beside it', async () => {
    const world = await searchWorld();
    const filters: Prisma.OfferWhereInput[] = [
      { status: OfferStatus.VIEWED },
      { requestId: world.requests[1]!.id },
      { providerId: world.providers[0]!.id },
      { submittedAt: { gte: new Date(Date.UTC(2026, 0, 10, 0, 0, 5)), lte: new Date(Date.UTC(2026, 0, 10, 0, 0, 12)) } },
      { request: { is: { city: { contains: 'i', mode: 'insensitive' } } } },
    ];
    for (const box of ['ışık', 'ivan', '0555 123 45 67', 'kadıköy', 'a']) {
      const search = await searchOf(box);
      for (const name of ['offersOnly', 'both'] as const) {
        for (const filter of filters) {
          const expected = await joinedIds(search, scopeOf(name), filter);
          for (const limit of [OFFER_SEARCH_ID_LIST_LIMIT, 0]) {
            expect(await resolvedIds(search, scopeOf(name), limit, filter), `${box} / ${name} / ${JSON.stringify(filter)}`).toEqual(
              expected,
            );
          }
        }
      }
    }
  });

  it('the list: total, figures and pages agree with the joined match, refund filter included', async () => {
    const world = await searchWorld();
    const service = new OffersService(ctx.prisma, null as never, null as never);
    for (const box of ['ışık', 'IŞIK', 'ivan', '0555 123 45 67', 'kadıköy', 'saklı müşteri']) {
      const search = await searchOf(box);
      for (const name of Object.keys(VIEWERS) as ViewerName[]) {
        const expected = await joinedIds(search, scopeOf(name));
        const first = await service.listOffers({ q: box, page: 1, pageSize: 3 }, viewer(name));
        expect(first.total, `${box} / ${name}`).toBe(expected.length);
        expect(first.summary.matching, `${box} / ${name}`).toBe(expected.length);
        const paged = [first];
        for (let page = 2; page <= first.totalPages; page += 1) {
          paged.push(await service.listOffers({ q: box, page, pageSize: 3 }, viewer(name)));
        }
        expect(paged.flatMap((res) => res.items.map((item) => item.id)), `${box} / ${name}`).toEqual(expected);

        // The figures count the joined match too.
        const fullRefund = await service.listOffers({ q: box, refundAction: 'FULL_REFUND', pageSize: 100 }, viewer(name));
        const noRefund = await service.listOffers({ q: box, refundAction: 'NO_REFUND', pageSize: 100 }, viewer(name));
        expect([...fullRefund.items, ...noRefund.items].map((item) => item.id).sort(), `${box} / ${name}`).toEqual(
          [...expected].sort(),
        );
        expect(first.summary.fullRefund).toBe(fullRefund.total);
        const viewed = await ctx.prisma.offer.count({ where: { AND: [{ id: { in: expected } }, viewedInPolicyWhere] } });
        expect(first.summary.viewed, `${box} / ${name}`).toBe(viewed);
        const newUnviewed = await ctx.prisma.offer.count({
          where: { id: { in: expected }, status: OfferStatus.SUBMITTED, viewedAt: null },
        });
        expect(first.summary.newUnviewed, `${box} / ${name}`).toBe(newUnviewed);
      }
    }
    expect(world.offers.length).toBeGreaterThan(10);
  });
});

/** The statements a list call sent, by what they read. */
function classify(sent: Array<{ query: string; params: string }>) {
  const resolver = (table: string) =>
    sent.filter((s) => s.query.startsWith(`SELECT "public"."${table}"."id" FROM "public"."${table}" WHERE`));
  return {
    offerResolver: resolver('Offer'),
    providerResolver: resolver('ProviderProfile'),
    requestResolver: resolver('ServiceRequest'),
    counts: sent.filter((s) => /^SELECT COUNT\(\*\) AS "_count\$_all" FROM \(SELECT "public"\."Offer"\."id" FROM "public"\."Offer"/.test(s.query)),
    page: sent.filter((s) => s.query.startsWith('SELECT "public"."Offer"."id", ') && /ORDER BY "public"\."Offer"\."submittedAt" DESC/.test(s.query)),
  };
}

describe('the statements', () => {
  it('resolve each table once, then read the offers by id lists with no join', async () => {
    const world = await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    for (const box of ['ışık', 'ivan', '0555 123 45 67', 'kadıköy']) {
      statements = [];
      await service.listOffers({ q: box, page: 1, pageSize: 5 }, viewer('both'));
      const sent = classify(statements);
      expect(sent.offerResolver, box).toHaveLength(1);
      expect(sent.providerResolver, box).toHaveLength(1);
      expect(sent.requestResolver, box).toHaveLength(1);
      // Each resolver is bounded: it asks for one row past the list's limit.
      for (const resolver of [...sent.offerResolver, ...sent.providerResolver, ...sent.requestResolver]) {
        expect(resolver.query, box).toMatch(/LIMIT \$\d+ OFFSET \$\d+$/);
        expect(JSON.parse(resolver.params).slice(-2), box).toEqual([OFFER_SEARCH_ID_LIST_LIMIT + 1, 0]);
      }
      expect(sent.counts, box).toHaveLength(4);
      expect(sent.page, box).toHaveLength(1);
      for (const statement of [...sent.counts, ...sent.page]) {
        expect(statement.query, box).not.toMatch(/JOIN/);
        expect(statement.query, box).not.toMatch(/ILIKE/);
        expect(statement.query, box).toMatch(/"public"\."Offer"\."(providerId|requestId|id)" IN \(/);
        expect(JSON.parse(statement.params).length, box).toBeLessThanOrEqual(3 * OFFER_SEARCH_ID_LIST_LIMIT + 20);
      }
    }
    expect(world.offers.length).toBeGreaterThan(0);
  });

  it('a box that matches nothing anywhere reads no offer row', async () => {
    await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    statements = [];
    const res = await service.listOffers({ q: 'zzqqxx' }, viewer('both'));
    expect(res).toMatchObject({ items: [], total: 0, summary: { matching: 0, fullRefund: 0, viewed: 0, newUnviewed: 0 } });
    for (const statement of [...classify(statements).counts, ...classify(statements).page]) {
      expect(statement.query).not.toMatch(/JOIN|ILIKE/);
    }
  });

  it('a provider or request filter keeps the search on its few offers, with no resolver', async () => {
    const world = await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    for (const filter of [{ providerId: world.providers[2]!.id }, { requestId: world.requests[1]!.id }]) {
      for (const box of ['ışık', 'ivan', 'kadıköy', '0555 123 45 67']) {
        for (const name of ['offersOnly', 'both'] as const) {
          statements = [];
          const res = await service.listOffers({ q: box, ...filter, pageSize: 100 }, viewer(name));
          const sent = classify(statements);
          expect([...sent.offerResolver, ...sent.providerResolver, ...sent.requestResolver], box).toHaveLength(0);
          expect(res.items.map((item) => item.id), `${box} / ${name}`).toEqual(
            await joinedIds(await searchOf(box), scopeOf(name), filter),
          );
        }
      }
    }
  });

  it('the city filter keeps its own join, and the search adds none', async () => {
    await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    statements = [];
    await service.listOffers({ q: 'ivan', city: 'ankara' }, viewer('both'));
    for (const statement of [...classify(statements).counts, ...classify(statements).page]) {
      expect(statement.query.match(/LEFT JOIN/g) ?? []).toHaveLength(1);
      expect(statement.query).toMatch(/LEFT JOIN "public"\."ServiceRequest"/);
      expect(statement.query).not.toMatch(/ProviderProfile/);
    }
  });

  it('the offer statements are served by the offer indexes (BitmapOr), not a scan of the table', async () => {
    const world = await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    statements = [];
    await service.listOffers({ q: 'ivan' }, viewer('both'));
    const sent = classify(statements);
    for (const statement of [sent.counts[0]!, sent.page[0]!]) {
      const plan = await bitmapOnlyPlan(statement);
      expect(plan).toContain('BitmapOr');
      // The provider arm is served by either index that leads with providerId.
      expect(plan.some((node) => node === 'Offer_providerId_idx' || node === 'Offer_providerId_requestId_key')).toBe(true);
      expect(plan).toContain('Offer_requestId_idx');
      expect(plan).not.toContain('Seq Scan');
    }
    expect(world.offers.length).toBeGreaterThan(0);
  });
});

describe('the resolvers are index-backed', () => {
  // Every arm of each resolver's OR, by reader: a BitmapOr needs an index on each.
  const expected: Record<'offersOnly' | 'both', Record<'Offer' | 'ProviderProfile' | 'ServiceRequest', string[]>> = {
    offersOnly: {
      Offer: ['Offer_id_trgm_idx'],
      ProviderProfile: ['ProviderProfile_id_trgm_idx', 'ProviderProfile_businessName_trgm_idx', 'ProviderProfile_businessNameSearch_trgm_idx'],
      ServiceRequest: [
        'ServiceRequest_id_trgm_idx',
        'ServiceRequest_city_trgm_idx',
        'ServiceRequest_citySearch_trgm_idx',
        'ServiceRequest_district_trgm_idx',
        'ServiceRequest_districtSearch_trgm_idx',
      ],
    },
    both: {
      Offer: ['Offer_id_trgm_idx'],
      ProviderProfile: [
        'ProviderProfile_id_trgm_idx',
        'ProviderProfile_businessName_trgm_idx',
        'ProviderProfile_businessNameSearch_trgm_idx',
        'ProviderProfile_contactName_trgm_idx',
        'ProviderProfile_contactNameSearch_trgm_idx',
        'ProviderProfile_phone_trgm_idx',
      ],
      ServiceRequest: [
        'ServiceRequest_id_trgm_idx',
        'ServiceRequest_customerName_trgm_idx',
        'ServiceRequest_customerNameSearch_trgm_idx',
        'ServiceRequest_customerEmail_trgm_idx',
        'ServiceRequest_customerPhone_trgm_idx',
        'ServiceRequest_city_trgm_idx',
        'ServiceRequest_citySearch_trgm_idx',
        'ServiceRequest_district_trgm_idx',
        'ServiceRequest_districtSearch_trgm_idx',
      ],
    },
  };

  it('each resolver is a BitmapOr of trigram indexes, one per arm, for text and phone boxes', async () => {
    await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    for (const name of ['offersOnly', 'both'] as const) {
      for (const box of ['ışık', 'sakli@example', '0555 123 45 67']) {
        statements = [];
        await service.listOffers({ q: box }, viewer(name));
        const sent = classify(statements);
        for (const [table, resolver] of [
          ['Offer', sent.offerResolver[0]!],
          ['ProviderProfile', sent.providerResolver[0]!],
          ['ServiceRequest', sent.requestResolver[0]!],
        ] as const) {
          const plan = await bitmapOnlyPlan(resolver);
          expect(plan, `${name} / ${box} / ${table}`).not.toContain('Seq Scan');
          for (const index of expected[name][table]) expect(plan, `${name} / ${box} / ${index}`).toContain(index);
          if (expected[name][table].length > 1) expect(plan, `${name} / ${box} / ${table}`).toContain('BitmapOr');
        }
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

/** The plan PostgreSQL makes for a recorded statement when it may only use bitmap index scans. */
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

describe('a table that matches more than the list holds keeps its join', () => {
  it('finds every offer, with the same total, figures and first pages, for every reader', async () => {
    const category = await createCategory(ctx.prisma);
    const requests = [
      await createApprovedRequest(ctx.prisma, { categoryId: category.id, city: 'Bursa', district: 'Nilüfer' }),
      await createApprovedRequest(ctx.prisma, { categoryId: category.id, city: 'Bursa', district: 'Nilüfer' }),
    ];
    const count = OFFER_SEARCH_ID_LIST_LIMIT + 1;
    await ctx.prisma.providerProfile.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        id: `bulkprov${String(i).padStart(5, '0')}`,
        businessName: `Toplu Usta ${i}`,
        contactName: `Yetkili ${i}`,
        phone: `+90533${String(i).padStart(7, '0')}`,
        taxType: 'SAHIS',
        taxNumber: `5${String(i).padStart(9, '0')}`,
        city: 'Bursa',
        district: 'Nilüfer',
        status: ProviderStatus.APPROVED,
      })),
    });
    await ctx.prisma.offer.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        requestId: requests[i % 2]!.id,
        providerId: `bulkprov${String(i).padStart(5, '0')}`,
        priceAmount: 1000,
        message: 'x',
        creditCost: 0,
        submittedAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i % 97)),
        ...(i % 5 === 0 ? { status: OfferStatus.VIEWED, viewedAt: new Date(Date.UTC(2026, 1, 2)), unviewedRefundPolicy: true } : {}),
      })),
    });
    await ctx.prisma.$executeRawUnsafe('VACUUM ANALYZE "Offer", "ProviderProfile", "ServiceRequest"');
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);

    // "toplu usta" matches every bulk provider: one more than a list holds.
    const search = await searchOf('toplu usta');
    for (const name of ['offersOnly', 'both'] as const) {
      const expected = await joinedIds(search, scopeOf(name));
      expect(expected).toHaveLength(count);
      statements = [];
      const pages = [];
      for (const page of [1, 2, 3]) pages.push(await service.listOffers({ q: 'toplu usta', page, pageSize: 50 }, viewer(name)));
      expect(pages[0]!.total).toBe(count);
      expect(pages[0]!.summary).toEqual({
        matching: count,
        fullRefund: 0,
        viewed: await ctx.prisma.offer.count({ where: viewedInPolicyWhere }),
        newUnviewed: await ctx.prisma.offer.count({ where: { status: OfferStatus.SUBMITTED, viewedAt: null } }),
      });
      expect(pages.flatMap((res) => res.items.map((item) => item.id))).toEqual(expected.slice(0, 150));

      // The provider table kept its join; no statement carried a list past the bound.
      const sent = classify(statements);
      for (const statement of [...sent.counts, ...sent.page]) {
        expect(statement.query).toMatch(/LEFT JOIN "public"\."ProviderProfile"/);
        expect(statement.query).not.toMatch(/"public"\."Offer"\."providerId" IN \(/);
        expect(JSON.parse(statement.params).length).toBeLessThanOrEqual(OFFER_SEARCH_ID_LIST_LIMIT + 20);
      }
    }

    // One fewer match, and the provider table is a list again.
    await ctx.prisma.offer.deleteMany({ where: { providerId: 'bulkprov00000' } });
    await ctx.prisma.providerProfile.delete({ where: { id: 'bulkprov00000' } });
    statements = [];
    const res = await service.listOffers({ q: 'toplu usta', pageSize: 50 }, viewer('both'));
    expect(res.total).toBe(OFFER_SEARCH_ID_LIST_LIMIT);
    for (const statement of [...classify(statements).counts, ...classify(statements).page]) {
      expect(statement.query).not.toMatch(/JOIN/);
      expect(statement.query).toMatch(/"public"\."Offer"\."providerId" IN \(/);
    }
  });
});

describe('one snapshot', () => {
  it('runs the resolvers, the counts and the page on one RepeatableRead transaction', async () => {
    await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    statements = [];
    await service.listOffers({ q: 'ivan' }, viewer('both'));
    const begin = statements.findIndex((s) => s.query === 'BEGIN');
    const commit = statements.findIndex((s) => s.query === 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(statements.filter((s) => s.query === 'BEGIN')).toHaveLength(1);
    expect(statements.slice(0, begin).some((s) => /REPEATABLE READ/.test(s.query)) || statements.slice(begin).some((s) => /REPEATABLE READ/.test(s.query))).toBe(true);
    const sent = classify(statements);
    for (const statement of [...sent.offerResolver, ...sent.providerResolver, ...sent.requestResolver, ...sent.counts, ...sent.page]) {
      const at = statements.indexOf(statement);
      expect(at).toBeGreaterThan(begin);
      expect(at).toBeLessThan(commit);
    }
  });

  it('an offer committed after the ids were resolved is in none of the counts or the page', async () => {
    const world = await searchWorld();
    const ivanProvider = world.providers[2]!; // contact "Ivan Petrov"
    const freshRequest = await createApprovedRequest(ctx.prisma, { categoryId: world.category.id, city: 'Bursa', district: 'Nilüfer' });
    let injected = false;
    // After the last resolver has read its ids — inside the list's transaction —
    // another connection commits a new offer from a matching provider.
    const hooked = logged.$extends({
      query: {
        serviceRequest: {
          async findMany({ args, query }) {
            const result = await query(args);
            if (!injected) {
              injected = true;
              await ctx.prisma.offer.create({
                data: {
                  requestId: freshRequest.id,
                  providerId: ivanProvider.id,
                  priceAmount: 1,
                  message: 'late',
                  creditCost: 0,
                  submittedAt: new Date(Date.UTC(2030, 0, 1)),
                },
              });
            }
            return result;
          },
        },
      },
    });
    const service = new OffersService(hooked as unknown as PrismaService, null as never, null as never);
    const search = await searchOf('ivan');
    const before = await joinedIds(search, scopeOf('both'));

    const res = await service.listOffers({ q: 'ivan', pageSize: 100 }, viewer('both'));
    expect(injected).toBe(true);
    // The new offer is the newest and matches; the snapshot the list read does not hold it.
    expect(res.total).toBe(before.length);
    expect(res.summary.matching).toBe(before.length);
    expect(res.summary.newUnviewed).toBe(
      await ctx.prisma.offer.count({ where: { id: { in: before }, status: OfferStatus.SUBMITTED, viewedAt: null } }),
    );
    expect(res.items.map((item) => item.id)).toEqual(before);
    // The next read sees it.
    expect((await service.listOffers({ q: 'ivan', pageSize: 100 }, viewer('both'))).total).toBe(before.length + 1);
  });
});

describe('a column the caller may not read is in no condition', () => {
  const providerContact = ['"contactName"', '"contactNameSearch"', '"phone"', '"email"'];
  const requestDetail = ['"customerName"', '"customerNameSearch"', '"customerPhone"', '"customerEmail"'];

  it('per reader, the resolvers name only the columns it may search, and the offer statements none', async () => {
    await searchWorld();
    const service = new OffersService(logged as unknown as PrismaService, null as never, null as never);
    for (const name of Object.keys(VIEWERS) as ViewerName[]) {
      const scope = scopeOf(name);
      for (const box of ['gizli yetkili', '0532 111 22 33', 'saklı müşteri', 'sakli@example', '0555 777 88 99']) {
        statements = [];
        const res = await service.listOffers({ q: box }, viewer(name));
        const sent = classify(statements);
        const providerSql = sent.providerResolver.map((s) => s.query).join('\n');
        const requestSql = sent.requestResolver.map((s) => s.query).join('\n');
        for (const column of providerContact.filter((c) => c !== '"email"')) {
          expect(providerSql.includes(column), `${name} / ${box} / ${column}`).toBe(scope.providerContact);
        }
        // The provider's e-mail is not part of the offer search, for any reader.
        expect(providerSql, `${name} / ${box}`).not.toContain('"email"');
        for (const column of requestDetail) {
          expect(requestSql.includes(column), `${name} / ${box} / ${column}`).toBe(scope.requestDetail);
        }
        for (const statement of [...sent.offerResolver, ...sent.counts, ...sent.page]) {
          for (const column of [...providerContact, ...requestDetail]) expect(statement.query, `${name} / ${column}`).not.toContain(column);
        }
        // And what the reader may not search finds nothing.
        const providerBox = box === 'gizli yetkili' || box === '0532 111 22 33';
        const allowed = providerBox ? scope.providerContact : scope.requestDetail;
        if (!allowed) {
          expect(res.total, `${name} / ${box}`).toBe(0);
          expect(res.summary, `${name} / ${box}`).toEqual({ matching: 0, fullRefund: 0, viewed: 0, newUnviewed: 0 });
        } else {
          expect(res.total, `${name} / ${box}`).toBeGreaterThan(0);
        }
        for (const row of res.items) {
          if (!scope.providerContact) for (const hidden of ['contactName', 'phone', 'email']) expect(row.provider).not.toHaveProperty(hidden);
          if (!scope.requestDetail) {
            for (const hidden of ['customerName', 'customerPhone', 'customerEmail']) expect(row.request).not.toHaveProperty(hidden);
          }
        }
      }
    }
  });
});
