import { AdminPermission, CreditTransactionType, Prisma, PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAdminTextSearch, phoneColumnMatchers, type AdminTextSearch } from '../src/common/admin-search';
import { FinanceService, LEDGER_PROVIDER_ID_LIST_LIMIT } from '../src/modules/finance/finance.service';
import { SEARCH_PROJECTION_OMIT, type PrismaService } from '../src/prisma/prisma.service';
import {
  createAdminWithPermissions,
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
 * ADMIN-SEARCH-INDEX-001: the finance providers list and the credit ledger
 * search through pg_trgm GIN indexes.
 *
 * Nothing here times a query: a threshold would be flaky and prove little on a
 * table of ten rows. What keeps the search index-backed is structural, and
 * that is what is asserted:
 *
 *   - the migration's indexes exist, exactly as declared;
 *   - every arm of the SQL Prisma really generates is one an index can serve —
 *     with sequential and plain index scans switched off, the planner still
 *     answers it with a BitmapOr of those indexes and no Seq Scan, which it
 *     cannot do if a single arm has no index;
 *   - the ledger no longer joins the provider into its OR (the shape no index
 *     serves), and its rows, count and pages are the ones the join gave.
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

const TRIGRAM_INDEXES = [
  ['ProviderCreditTransaction', 'ProviderCreditTransaction_reasonSearch_trgm_idx', '"reasonSearch"'],
  ['ProviderCreditTransaction', 'ProviderCreditTransaction_reason_trgm_idx', 'reason'],
  ['ProviderProfile', 'ProviderProfile_businessNameSearch_trgm_idx', '"businessNameSearch"'],
  ['ProviderProfile', 'ProviderProfile_businessName_trgm_idx', '"businessName"'],
  ['ProviderProfile', 'ProviderProfile_email_trgm_idx', 'email'],
  ['ProviderProfile', 'ProviderProfile_phone_trgm_idx', 'phone'],
  // ADMIN-SEARCH-PAGINATION-001: the customer list's search box.
  ['User', 'User_email_trgm_idx', 'email'],
  ['User', 'User_nameSearch_trgm_idx', '"nameSearch"'],
  ['User', 'User_name_trgm_idx', 'name'],
  ['User', 'User_phone_trgm_idx', 'phone'],
] as const;

describe('the migration', () => {
  it('installs pg_trgm and exactly the declared trigram indexes', async () => {
    const extensions = await ctx.prisma.$queryRaw<Array<{ extname: string }>>(
      Prisma.sql`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(extensions).toEqual([{ extname: 'pg_trgm' }]);

    const indexes = await ctx.prisma.$queryRaw<Array<{ tablename: string; indexname: string; indexdef: string }>>(
      Prisma.sql`SELECT tablename, indexname, indexdef FROM pg_indexes
                 WHERE schemaname = 'public' AND indexdef LIKE '%gin_trgm_ops%' ORDER BY indexname`,
    );
    expect(indexes).toEqual(
      TRIGRAM_INDEXES.map(([table, name, column]) => ({
        tablename: table,
        indexname: name,
        indexdef: `CREATE INDEX "${name}" ON public."${table}" USING gin (${column} gin_trgm_ops)`,
      })),
    );
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
 * a plan without one proves every arm of the WHERE is served by an index.
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

const searchStatements = (table: string) =>
  statements.filter((statement) => statement.query.includes(`FROM "public"."${table}"`) && /ILIKE/.test(statement.query));

const contactViewer = { id: 'viewer', role: UserRole.SUPER_ADMIN, permissions: [] } as never;
const financeOnlyViewer = {
  id: 'viewer',
  role: UserRole.ADMIN,
  permissions: [AdminPermission.FINANCE_READ, AdminPermission.FINANCE_LEDGER_READ],
} as never;

async function providerWorld() {
  const isik = await createProviderProfile(ctx.prisma, { email: 'ivan.usta@example.test' });
  await ctx.prisma.providerProfile.update({
    where: { id: isik.id },
    data: { businessName: 'IŞIK Tesisat', phone: '+905551234567' },
  });
  const other = await createProviderProfile(ctx.prisma, { email: 'baska@example.test' });
  await ctx.prisma.providerProfile.update({
    where: { id: other.id },
    data: { businessName: 'Çağrı Elektrik', phone: '+905559876543' },
  });
  let balance = 0;
  const ledgerRow = (providerId: string, reason: string | null) => {
    balance += 1;
    return ctx.prisma.providerCreditTransaction.create({
      data: { providerId, type: CreditTransactionType.ADMIN_GRANT, amount: 1, balanceAfter: balance, reason },
    });
  };
  for (const reason of ['Paket satın alma', 'Işık kampanyası', null, 'Destek telafisi']) {
    await ledgerRow(isik.id, reason);
    await ledgerRow(other.id, reason);
  }
  return { isik, other };
}

describe('GET /finance/providers — generated SQL', () => {
  it('is answered by a BitmapOr of trigram indexes, contact arms only with PROVIDERS_READ', async () => {
    await providerWorld();
    const finance = new FinanceService(logged as unknown as PrismaService);

    await finance.listProviderFinance({ q: 'ışık' } as never, contactViewer);
    const [withContact] = searchStatements('ProviderProfile');
    expect(withContact!.query).toMatch(/"phone" ILIKE/);
    expect(withContact!.query).toMatch(/"email" ILIKE/);
    const contactPlan = await bitmapOnlyPlan(withContact!);
    expect(contactPlan).not.toContain('Seq Scan');
    expect(contactPlan).toContain('BitmapOr');
    expect(contactPlan).toEqual(
      expect.arrayContaining([
        'ProviderProfile_businessName_trgm_idx',
        'ProviderProfile_businessNameSearch_trgm_idx',
        'ProviderProfile_phone_trgm_idx',
        'ProviderProfile_email_trgm_idx',
      ]),
    );

    statements = [];
    await finance.listProviderFinance({ q: 'ışık' } as never, financeOnlyViewer);
    const [withoutContact] = searchStatements('ProviderProfile');
    expect(withoutContact!.query).not.toMatch(/"(phone|email)" (ILIKE|IN)/);
    const plan = await bitmapOnlyPlan(withoutContact!);
    expect(plan).not.toContain('Seq Scan');
    expect(plan.filter((name) => name.endsWith('_trgm_idx')).sort()).toEqual([
      'ProviderProfile_businessNameSearch_trgm_idx',
      'ProviderProfile_businessName_trgm_idx',
    ]);
  });

  it('keeps the exact phone spellings on the phone B-tree', async () => {
    await providerWorld();
    const finance = new FinanceService(logged as unknown as PrismaService);

    await finance.listProviderFinance({ q: '0555 123 45 67' } as never, contactViewer);
    const plan = await bitmapOnlyPlan(searchStatements('ProviderProfile')[0]!);
    expect(plan).not.toContain('Seq Scan');
    expect(plan).toEqual(expect.arrayContaining(['ProviderProfile_phone_idx', 'ProviderProfile_phone_trgm_idx']));
  });
});

/** The ledger's search as it was written before this change: the provider joined into the OR. */
function joinedLedgerWhere(search: AdminTextSearch, providerContact: boolean): Prisma.ProviderCreditTransactionWhereInput {
  return {
    OR: [
      { reason: { contains: search.text, mode: 'insensitive' } },
      { reasonSearch: { contains: search.folded } },
      {
        provider: {
          is: {
            OR: [
              { businessName: { contains: search.text, mode: 'insensitive' } },
              { businessNameSearch: { contains: search.folded } },
              ...(providerContact
                ? [
                    ...phoneColumnMatchers(search).map((phone) => ({ phone })),
                    { email: { contains: search.text, mode: 'insensitive' as const } },
                  ]
                : []),
            ],
          },
        },
      },
    ],
  };
}

/** Every row, the total and every page the service returns equal what the joined search returned. */
async function expectSameAsJoinedSearch(box: string) {
  const finance = ctx.app.get(FinanceService);
  const search = (await parseAdminTextSearch(ctx.prisma, box))!;
  for (const [viewer, providerContact] of [
    [contactViewer, true],
    [financeOnlyViewer, false],
  ] as const) {
    const expected = (
      await ctx.prisma.providerCreditTransaction.findMany({
        where: joinedLedgerWhere(search, providerContact),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).map((row) => row.id);

    const pageSize = 3;
    const seen: string[] = [];
    let page = 1;
    for (;;) {
      const result = await finance.listCreditLedger({ q: box, page, pageSize } as never, viewer);
      expect(result.total, `${box} total`).toBe(expected.length);
      seen.push(...result.items.map((item: { id: string }) => item.id));
      if (!result.hasNextPage) break;
      page += 1;
    }
    expect(seen, `${box} (contact ${providerContact})`).toEqual(expected);
  }
}

describe('GET /finance/credit-ledger — provider arm', () => {
  it('asks the ledger for providerId IN (…) instead of joining the provider into the OR', async () => {
    const { isik } = await providerWorld();
    const finance = new FinanceService(logged as unknown as PrismaService);

    await finance.listCreditLedger({ q: 'ışık tesisat' } as never, contactViewer);
    const ledger = searchStatements('ProviderCreditTransaction');
    expect(ledger).toHaveLength(2); // count + page
    for (const statement of ledger) {
      expect(statement.query).not.toMatch(/JOIN "public"\."ProviderProfile"/);
      expect(statement.query).toMatch(/"ProviderCreditTransaction"\."providerId" IN \(/);
      expect(JSON.parse(statement.params)).toContain(isik.id);
    }

    const count = ledger.find((statement) => statement.query.startsWith('SELECT COUNT'))!;
    const plan = await bitmapOnlyPlan(count);
    expect(plan).not.toContain('Seq Scan');
    expect(plan).toContain('BitmapOr');
    expect(plan).toEqual(
      expect.arrayContaining([
        'ProviderCreditTransaction_reason_trgm_idx',
        'ProviderCreditTransaction_reasonSearch_trgm_idx',
        'ProviderCreditTransaction_providerId_idx',
      ]),
    );

    // The providers it matched were found on their own table, by index.
    const [providerLookup] = searchStatements('ProviderProfile');
    expect(await bitmapOnlyPlan(providerLookup!)).not.toContain('Seq Scan');
  });

  it('never searches the provider phone or e-mail without PROVIDERS_READ', async () => {
    await providerWorld();
    const finance = new FinanceService(logged as unknown as PrismaService);

    await finance.listCreditLedger({ q: '+905551234567' } as never, financeOnlyViewer);
    const [providerLookup] = searchStatements('ProviderProfile');
    expect(providerLookup!.query).not.toMatch(/"(phone|email)" (ILIKE|IN)/);

    for (const box of ['+905551234567', '0555 123 45 67', 'ivan.usta']) {
      expect((await finance.listCreditLedger({ q: box } as never, financeOnlyViewer)).total, box).toBe(0);
      expect((await finance.listCreditLedger({ q: box } as never, contactViewer)).total, box).toBe(4);
    }
  });

  it('returns the rows, total and pages the joined search returned', async () => {
    await providerWorld();
    for (const box of [
      'ışık', // business name and reason, folded
      'IŞIK',
      'ivan', // locale-free arm: "ivan.usta@" only with PROVIDERS_READ
      'ivan.usta@example.test',
      '+905551234567',
      '0555 123 45 67',
      '5551234',
      'çağrı elektrik',
      'kampanya', // reason only
      'tesisat',
      'yok-boyle-bir-sey',
    ]) {
      await expectSameAsJoinedSearch(box);
    }
  });

  it(`keeps the join when more than ${LEDGER_PROVIDER_ID_LIST_LIMIT} providers match, with the same rows`, async () => {
    await providerWorld();
    const many = LEDGER_PROVIDER_ID_LIST_LIMIT + 1;
    await ctx.prisma.providerProfile.createMany({
      data: Array.from({ length: many }, (_, index) => ({
        businessName: `Toplu Işık Firma ${index}`,
        contactName: 'Toplu',
        phone: '+905550000000',
        city: 'İstanbul',
        district: 'Kadıköy',
      })),
    });
    const sample = await ctx.prisma.providerProfile.findMany({
      where: { businessName: { startsWith: 'Toplu' } },
      select: { id: true },
      take: 4,
    });
    for (const [index, provider] of sample.entries()) {
      await ctx.prisma.providerCreditTransaction.create({
        data: { providerId: provider.id, type: CreditTransactionType.ADMIN_GRANT, amount: 1, balanceAfter: index + 1 },
      });
    }

    const finance = new FinanceService(logged as unknown as PrismaService);
    await finance.listCreditLedger({ q: 'ışık' } as never, contactViewer);
    for (const statement of searchStatements('ProviderCreditTransaction')) {
      expect(statement.query).toMatch(/JOIN "public"\."ProviderProfile"/);
    }

    await expectSameAsJoinedSearch('ışık');
    await expectSameAsJoinedSearch('toplu');
  });
});

describe('GET /finance/credit-ledger over HTTP', () => {
  it('finds a provider by phone only for a caller holding PROVIDERS_READ', async () => {
    const { isik } = await providerWorld();
    const sessionWith = async (permissions: AdminPermission[]) => {
      const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
      return loginAs(ctx.prisma, admin.id);
    };
    const ledgerOnly = await sessionWith([AdminPermission.FINANCE_LEDGER_READ]);
    const withContact = await sessionWith([AdminPermission.FINANCE_LEDGER_READ, AdminPermission.PROVIDERS_READ]);
    const root = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: null })).id);

    const get = async (cookie: string) => {
      const response = await request(ctx.server)
        .get(`/finance/credit-ledger?q=${encodeURIComponent('0555 123 45 67')}`)
        .set('Cookie', cookie);
      expect(response.status).toBe(200);
      return response.body as { total: number; items: Array<{ provider: { id: string; phone?: string } }> };
    };

    const hidden = await get(ledgerOnly);
    expect(hidden.total).toBe(0);
    for (const cookie of [withContact, root]) {
      const found = await get(cookie);
      expect(found.total).toBe(4);
      expect(found.items.every((row) => row.provider.id === isik.id)).toBe(true);
    }
  });
});
