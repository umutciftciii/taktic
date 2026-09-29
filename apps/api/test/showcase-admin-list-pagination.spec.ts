import {
  AdminPermission,
  ServiceCategoryKind,
  ServiceRequestStatus,
  ShowcaseLeadStatus,
  ShowcaseLeadUrgency,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptShowcasePriceTerms,
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * API-HARDENING-001 (3/4): the vitrin lead list and the price-terms ledger
 * page on the server instead of stopping at 200 rows.
 *
 * What is pinned here: every row is reachable by page, the total is exact
 * (never "the rows on this page"), the filters and the newest-first order
 * survive paging, and the tab counts do not depend on the page or the chosen
 * view.
 */
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

const MINUTE = 60 * 1000;

async function providerWithPlacement(name: string) {
  const category = await createCategory(ctx.prisma, `Klima ${name}`, { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: profile.id,
    categoryId: category.id,
  });
  const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: profile.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });
  return { category, user, profile, card, version, placement };
}

let requestSeq = 0;

/** `count` leads, the i-th created `i` minutes after `base`, with a status chosen per index. */
async function seedLeads(
  owner: Awaited<ReturnType<typeof providerWithPlacement>>,
  count: number,
  status: (index: number) => ShowcaseLeadStatus,
  base = Date.now() - 10 * 24 * 60 * MINUTE,
) {
  const requests = Array.from({ length: count }, () => {
    requestSeq += 1;
    return {
      id: `req_${owner.profile.id.slice(-6)}_${requestSeq}`,
      categoryId: owner.category.id,
      requestNumber: `TR-PAGE-${requestSeq}`,
      customerName: `Müşteri ${requestSeq}`,
      customerPhone: `05554${String(requestSeq).padStart(6, '0')}`,
      city: 'İstanbul',
      district: 'Kadıköy',
      status: ServiceRequestStatus.APPROVED,
      qualityScore: 80,
    };
  });
  await ctx.prisma.serviceRequest.createMany({ data: requests });
  await ctx.prisma.showcaseLead.createMany({
    data: requests.map((row, index) => ({
      requestId: row.id,
      placementId: owner.placement.id,
      cardId: owner.card.id,
      cardVersionId: owner.version.id,
      kindSnapshot: owner.card.kind,
      listedPriceSnapshot: owner.version.listedServicePriceAmount,
      providerId: owner.profile.id,
      urgencyBucket: ShowcaseLeadUrgency.NORMAL,
      slaHoursSnapshot: 24,
      slaDueAt: new Date(base + index * MINUTE + 24 * 60 * MINUTE),
      status: status(index),
      createdAt: new Date(base + index * MINUTE),
    })),
  });
  return requests.map((row) => row.id);
}

async function reader(permission: AdminPermission) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, [permission]);
  return loginAs(ctx.prisma, admin.id);
}

describe('GET /admin/showcase/leads', () => {
  it('reaches every lead past the old 200 cap, newest first, with an exact total', async () => {
    const owner = await providerWithPlacement('a');
    const requestIds = await seedLeads(owner, 230, () => ShowcaseLeadStatus.OPEN);
    const cookie = await reader(AdminPermission.SHOWCASE_LEADS_READ);

    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await request(ctx.server)
        .get(`/admin/showcase/leads?page=${page}&pageSize=100`)
        .set('Cookie', cookie);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ total: 230, page, pageSize: 100, hasNextPage: page < 3 });
      seen.push(...response.body.leads.map((lead: { request: { id: string } }) => lead.request.id));
    }

    // Every lead once, newest first — the oldest one is the very last row.
    expect(seen).toHaveLength(230);
    expect(new Set(seen).size).toBe(230);
    expect(seen).toEqual([...requestIds].reverse());
  });

  it('keeps the status and provider filters across pages and counts the tabs without the status filter', async () => {
    const a = await providerWithPlacement('a');
    const b = await providerWithPlacement('b');
    await seedLeads(a, 60, (index) => (index % 3 === 0 ? ShowcaseLeadStatus.BREACHED : ShowcaseLeadStatus.OPEN));
    await seedLeads(b, 15, () => ShowcaseLeadStatus.BREACHED);
    const cookie = await reader(AdminPermission.SHOWCASE_LEADS_READ);

    const response = await request(ctx.server)
      .get(`/admin/showcase/leads?status=BREACHED&providerId=${a.profile.id}&page=2&pageSize=15`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(20);
    expect(response.body.leads).toHaveLength(5);
    expect(response.body.hasNextPage).toBe(false);
    for (const lead of response.body.leads) {
      expect(lead.status).toBe('BREACHED');
      expect(lead.provider.id).toBe(a.profile.id);
    }
    expect(response.body.statusCounts).toEqual({
      OPEN: 40,
      ANSWERED: 0,
      BREACHED: 20,
      RELEASED: 0,
      CLOSED_UNANSWERED: 0,
    });
  });

  it('answers a page past the end with no rows and the real total', async () => {
    const owner = await providerWithPlacement('a');
    await seedLeads(owner, 3, () => ShowcaseLeadStatus.OPEN);
    const cookie = await reader(AdminPermission.SHOWCASE_LEADS_READ);

    const response = await request(ctx.server).get('/admin/showcase/leads?page=9').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ leads: [], total: 3, page: 9, pageSize: 50, hasNextPage: false });
  });

  it.each([
    ['page=0'],
    ['page=abc'],
    ['page=2abc'],
    ['pageSize=0'],
    ['pageSize=101'],
    ['status=NOPE'],
    ['unknown=1'],
  ])('refuses %s with 400', async (query) => {
    const cookie = await reader(AdminPermission.SHOWCASE_LEADS_READ);
    const response = await request(ctx.server).get(`/admin/showcase/leads?${query}`).set('Cookie', cookie);
    expect(response.status).toBe(400);
  });

  it('still requires SHOWCASE_LEADS_READ', async () => {
    const cookie = await reader(AdminPermission.SHOWCASE_PLACEMENTS_READ);
    expect((await request(ctx.server).get('/admin/showcase/leads').set('Cookie', cookie)).status).toBe(403);
  });
});

describe('GET /admin/showcase/price-terms-acceptances', () => {
  async function seedAcceptances() {
    const a = await providerWithPlacement('a');
    const b = await providerWithPlacement('b');
    const base = Date.now() - 30 * 24 * 60 * MINUTE;
    // 130 card-bound acceptances for a (one per card and version), 120
    // package-bound for b — together past both old per-table caps' merge.
    const cards = await Promise.all(
      Array.from({ length: 65 }, () =>
        createApprovedShowcaseCard(ctx.prisma, { providerId: a.profile.id, categoryId: a.category.id }),
      ),
    );
    let minute = 0;
    const rows: Array<{ id: string; at: number }> = [];
    for (const { card } of cards) {
      for (const termsVersion of ['2026-01', '2026-02']) {
        minute += 2;
        const row = await acceptShowcasePriceTerms(ctx.prisma, {
          providerId: a.profile.id,
          cardId: card.id,
          userId: a.user.id,
          termsVersion,
          acceptedAt: new Date(base + minute * MINUTE),
        });
        rows.push({ id: row.id, at: base + minute * MINUTE });
      }
    }
    const packageRows = Array.from({ length: 120 }, (_, index) => ({
      id: `pkgacc_${String(index).padStart(4, '0')}`,
      providerId: index % 2 === 0 ? b.profile.id : a.profile.id,
      termsVersion: `pkg-${String(index).padStart(3, '0')}`,
      termsTextSnapshot: 'Metin',
      acceptedByUserId: index % 2 === 0 ? b.user.id : a.user.id,
      // Interleaved with the card rows so the two tables really merge.
      acceptedAt: new Date(base + (index * 2 + 1) * MINUTE),
    }));
    await ctx.prisma.showcasePackageTermsAcceptance.createMany({ data: packageRows });
    for (const row of packageRows) rows.push({ id: row.id, at: row.acceptedAt.getTime() });
    // The card rows written by createLiveShowcasePlacement for each provider.
    const fixtures = await ctx.prisma.showcaseCardPriceTermsAcceptance.findMany({
      where: { cardId: { in: [a.card.id, b.card.id] } },
    });
    for (const row of fixtures) rows.push({ id: row.id, at: row.acceptedAt.getTime() });
    rows.sort((x, y) => y.at - x.at || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0));
    return { a, b, rows };
  }

  it('merges both tables newest first and reaches every row by page with an exact total', async () => {
    const { rows } = await seedAcceptances();
    const cookie = await reader(AdminPermission.SHOWCASE_TERMS_ACCEPTANCES_READ);

    const seen: string[] = [];
    for (let page = 1; ; page += 1) {
      const response = await request(ctx.server)
        .get(`/admin/showcase/price-terms-acceptances?page=${page}&pageSize=100`)
        .set('Cookie', cookie);
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(rows.length);
      seen.push(...response.body.acceptances.map((row: { id: string }) => row.id));
      if (!response.body.hasNextPage) break;
    }

    expect(rows.length).toBeGreaterThan(250);
    expect(seen).toEqual(rows.map((row) => row.id));
  });

  it('pages a version-filtered list and counts versions without the version filter', async () => {
    const { a } = await seedAcceptances();
    const cookie = await reader(AdminPermission.SHOWCASE_TERMS_ACCEPTANCES_READ);

    const response = await request(ctx.server)
      .get(`/admin/showcase/price-terms-acceptances?providerId=${a.profile.id}&termsVersion=2026-01&pageSize=20&page=4`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(65);
    expect(response.body.acceptances).toHaveLength(5);
    expect(response.body.hasNextPage).toBe(false);
    for (const row of response.body.acceptances) {
      expect(row).toMatchObject({ termsVersion: '2026-01', providerId: a.profile.id, scope: 'CARD' });
    }
    const counts = Object.fromEntries(
      response.body.versions.map((entry: { termsVersion: string; count: number }) => [entry.termsVersion, entry.count]),
    );
    expect(counts['2026-01']).toBe(65);
    expect(counts['2026-02']).toBe(65);
    // a's own package acceptances are in the scope, b's are not.
    expect(counts['pkg-001']).toBe(1);
    expect(counts['pkg-000']).toBeUndefined();
  });

  it('lists only card-bound rows when filtered by card', async () => {
    const { a } = await seedAcceptances();
    const cookie = await reader(AdminPermission.SHOWCASE_TERMS_ACCEPTANCES_READ);

    const response = await request(ctx.server)
      .get(`/admin/showcase/price-terms-acceptances?cardId=${a.card.id}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(response.body.acceptances.length);
    expect(response.body.acceptances.every((row: { scope: string; cardId: string }) => row.scope === 'CARD' && row.cardId === a.card.id)).toBe(true);
  });

  it('binds filter values as parameters', async () => {
    await seedAcceptances();
    const cookie = await reader(AdminPermission.SHOWCASE_TERMS_ACCEPTANCES_READ);

    const response = await request(ctx.server)
      .get(`/admin/showcase/price-terms-acceptances?termsVersion=${encodeURIComponent(`x' OR '1'='1`)}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ acceptances: [], total: 0, versions: expect.any(Array) });
  });

  it.each([['page=0'], ['pageSize=101'], ['page=1.5'], ['unknown=1']])('refuses %s with 400', async (query) => {
    const cookie = await reader(AdminPermission.SHOWCASE_TERMS_ACCEPTANCES_READ);
    const response = await request(ctx.server)
      .get(`/admin/showcase/price-terms-acceptances?${query}`)
      .set('Cookie', cookie);
    expect(response.status).toBe(400);
  });
});
