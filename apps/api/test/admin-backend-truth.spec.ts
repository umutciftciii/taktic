import {
  AdminPermission,
  ServiceCategoryKind,
  ServiceRequestReportReason,
  ServiceRequestReportResolution,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  effectiveShowcaseEntitlementStatus,
  SHOWCASE_ENTITLEMENT_EFFECTIVE_STATUSES,
  showcaseEntitlementEffectiveWhere,
} from '../src/modules/showcase/showcase-entitlement-status';
import {
  backdateOfferSubmission,
  createAdminWithPermissions,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createShowcaseEntitlement,
  createShowcasePackage,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  showcaseCardPayload,
  SHOWCASE_SUBMIT_BODY,
  type TestContext,
} from './harness';

/**
 * ADMIN-BACKEND-TRUTH-001: the numbers and statuses admin screens show are the
 * database's, counted by the same predicate as the list they link to.
 *
 * A — `GET /package-purchases?showcasePackageId=` filters, pages and totals on
 *     the server; `GET /package-purchases/summary` adds the filtered set up.
 * B — a vitrin purchase carries its right's *effective* status.
 * C — the dashboard's vitrin queue count is the review queue's length.
 * D — the dashboard's reported-request count is the open report queue's
 *     `total`, one per request.
 * E — the refund scan is paged; its `total` is the dashboard's count.
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

async function superAdminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

function get(cookie: string, path: string) {
  return request(ctx.server).get(path).set('Cookie', cookie);
}

/** A provider with a login, in one leaf category. */
async function vitrinProvider() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  return { category, user, provider, cookie: await loginAs(ctx.prisma, user.id) };
}

/** A PENDING vitrin checkout for `packageId` — opened, never paid. */
async function pendingVitrinPurchase(providerId: string, packageId: string) {
  const pkg = await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: packageId } });
  const acceptance = await ctx.prisma.showcasePackageTermsAcceptance.findFirstOrThrow({ where: { providerId } });
  return ctx.prisma.packagePurchase.create({
    data: {
      providerId,
      kind: 'SHOWCASE_PACKAGE',
      showcasePackageId: pkg.id,
      durationDaysSnapshot: pkg.durationDays,
      creditAmountSnapshot: 0,
      priceAmountSnapshot: pkg.priceAmount,
      currencySnapshot: pkg.currency,
      packageNameSnapshot: pkg.name,
      showcasePackageTermsAcceptanceId: acceptance.id,
      status: 'PENDING',
    },
  });
}

type PurchaseRow = {
  id: string;
  status: string;
  showcasePackage: { id: string } | null;
  showcaseEntitlement: Record<string, unknown> | null;
};

/* ------------------------------------------------------------------------ */

describe('A — vitrin package filter on the purchase list', () => {
  async function scene() {
    const { provider, user } = await vitrinProvider();
    const target = await createShowcasePackage(ctx.prisma, { priceAmount: 10_000 });
    const other = await createShowcasePackage(ctx.prisma, { priceAmount: 99_000 });
    const paid = [];
    for (let i = 0; i < 3; i += 1) {
      paid.push(await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: target.id }));
    }
    const pending = await pendingVitrinPurchase(provider.id, target.id);
    for (let i = 0; i < 2; i += 1) {
      await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: other.id });
    }
    return { target, other, ids: [...paid.map((p) => p.purchase.id), pending.id].sort() };
  }

  it('lists exactly the package’s purchases, and no other package’s', async () => {
    const { target, ids } = await scene();
    const cookie = await superAdminCookie();

    const body = (await get(cookie, `/package-purchases?showcasePackageId=${target.id}`).expect(200)).body as PurchaseRow[];
    expect(body.map((row) => row.id).sort()).toEqual(ids);
    expect(body.every((row) => row.showcasePackage?.id === target.id)).toBe(true);
  });

  it('pages inside the filter with a total of the filtered set, no duplicate and no gap', async () => {
    const { target, ids } = await scene();
    const cookie = await superAdminCookie();

    const first = (await get(cookie, `/package-purchases?showcasePackageId=${target.id}&page=1&pageSize=3`).expect(200))
      .body;
    const second = (await get(cookie, `/package-purchases?showcasePackageId=${target.id}&page=2&pageSize=3`).expect(200))
      .body;
    expect(first).toMatchObject({ total: 4, page: 1, pageSize: 3, hasNextPage: true });
    expect(first.items).toHaveLength(3);
    expect(second).toMatchObject({ total: 4, page: 2, pageSize: 3, hasNextPage: false });
    expect(second.items).toHaveLength(1);

    const seen = [...first.items, ...second.items].map((row: PurchaseRow) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(ids);
  });

  it('works with the existing filters, and they keep working on their own', async () => {
    const { target, other } = await scene();
    const cookie = await superAdminCookie();

    const paid = (await get(cookie, `/package-purchases?showcasePackageId=${target.id}&status=PAID&pageSize=50`).expect(200))
      .body;
    expect(paid.total).toBe(3);
    expect(paid.items.every((row: PurchaseRow) => row.status === 'PAID')).toBe(true);

    // Unfiltered and status-only reads are the whole list, as before.
    expect(((await get(cookie, '/package-purchases').expect(200)).body as PurchaseRow[]).length).toBe(6);
    expect(((await get(cookie, '/package-purchases?status=PENDING').expect(200)).body as PurchaseRow[]).length).toBe(1);
    expect(
      ((await get(cookie, `/package-purchases?showcasePackageId=${other.id}`).expect(200)).body as PurchaseRow[]).length,
    ).toBe(2);
  });

  it('refuses a page size beyond the bound and a page that is not a number', async () => {
    const cookie = await superAdminCookie();
    await get(cookie, '/package-purchases?pageSize=101').expect(400);
    await get(cookie, '/package-purchases?page=0').expect(400);
    await get(cookie, '/package-purchases?page=abc').expect(400);
  });

  it('adds the filtered set up on the server', async () => {
    const { target } = await scene();
    const cookie = await superAdminCookie();

    const summary = (await get(cookie, `/package-purchases/summary?showcasePackageId=${target.id}`).expect(200)).body;
    expect(summary.total).toBe(4);
    expect(summary.byStatus).toMatchObject({ PAID: 3, PENDING: 1, FAILED: 0 });
    expect(summary.paidRevenue).toEqual([{ currency: 'TRY', amount: 30_000 }]);
    expect(summary.activeRuns).toBe(0);
    expect(summary.entitlements).toEqual({ AVAILABLE: 3, RESERVED: 0, CONSUMED: 0, EXPIRED: 0 });
  });

  it('keeps the summary and the list behind PACKAGE_PURCHASES_READ', async () => {
    const { target } = await scene();
    const cookie = await sessionWith([AdminPermission.SHOWCASE_PACKAGES_READ]);
    await get(cookie, `/package-purchases?showcasePackageId=${target.id}`).expect(403);
    await get(cookie, `/package-purchases/summary?showcasePackageId=${target.id}`).expect(403);
  });
});

/* ------------------------------------------------------------------------ */

describe('B — the vitrin right’s status on the purchase projection', () => {
  it('reports AVAILABLE with the remaining window, the same on the list and the detail', async () => {
    const { provider, user } = await vitrinProvider();
    const pkg = await createShowcasePackage(ctx.prisma);
    const { purchase, entitlement } = await createShowcaseEntitlement(ctx, {
      providerId: provider.id,
      userId: user.id,
      packageId: pkg.id,
    });
    const cookie = await superAdminCookie();

    const detail = (await get(cookie, `/package-purchases/${purchase.id}`).expect(200)).body;
    const listed = ((await get(cookie, `/package-purchases?showcasePackageId=${pkg.id}`).expect(200)).body as PurchaseRow[])[0]!;
    expect(detail.showcaseEntitlement).toMatchObject({
      id: entitlement.id,
      status: 'AVAILABLE',
      storedStatus: 'AVAILABLE',
      usedAt: null,
      pausedForReview: false,
      remainingDays: 90,
      placementId: null,
    });
    expect(listed.showcaseEntitlement).toEqual(detail.showcaseEntitlement);
  });

  it('reports EXPIRED once the window closed, before the sweeper has written it', async () => {
    const { provider, user } = await vitrinProvider();
    const pkg = await createShowcasePackage(ctx.prisma);
    const { purchase, entitlement } = await createShowcaseEntitlement(ctx, {
      providerId: provider.id,
      userId: user.id,
      packageId: pkg.id,
      paidAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });
    expect(entitlement.status).toBe('AVAILABLE');
    const cookie = await superAdminCookie();

    const detail = (await get(cookie, `/package-purchases/${purchase.id}`).expect(200)).body;
    expect(detail.showcaseEntitlement).toMatchObject({ status: 'EXPIRED', storedStatus: 'AVAILABLE', remainingDays: null });

    const summary = (await get(cookie, `/package-purchases/summary?showcasePackageId=${pkg.id}`).expect(200)).body;
    expect(summary.entitlements).toEqual({ AVAILABLE: 0, RESERVED: 0, CONSUMED: 0, EXPIRED: 1 });
  });

  it('follows the right through review: RESERVED and paused, then CONSUMED with its run', async () => {
    const { provider, user, category, cookie: providerCookie } = await vitrinProvider();
    const pkg = await createShowcasePackage(ctx.prisma);
    const { purchase } = await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: pkg.id });
    const adminCookie = await superAdminCookie();

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', providerCookie)
      .send(showcaseCardPayload(category.id))
      .expect(201);
    const submitted = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards/${created.body.id}/submit`)
      .set('Cookie', providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(200);

    const reserved = (await get(adminCookie, `/package-purchases/${purchase.id}`).expect(200)).body.showcaseEntitlement;
    expect(reserved).toMatchObject({ status: 'RESERVED', pausedForReview: true, remainingDays: null, usedAt: null });

    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(200);

    const used = (await get(adminCookie, `/package-purchases/${purchase.id}`).expect(200)).body.showcaseEntitlement;
    expect(used).toMatchObject({ status: 'CONSUMED', storedStatus: 'CONSUMED', remainingDays: null, pausedForReview: false });
    expect(used.usedAt).not.toBeNull();
    expect(used.placementId).not.toBeNull();

    const summary = (await get(adminCookie, `/package-purchases/summary?showcasePackageId=${pkg.id}`).expect(200)).body;
    expect(summary.entitlements).toEqual({ AVAILABLE: 0, RESERVED: 0, CONSUMED: 1, EXPIRED: 0 });
    expect(summary.activeRuns).toBe(1);
  });

  it('is null for a credit-package purchase', async () => {
    const { provider } = await vitrinProvider();
    const creditPackage = await ctx.prisma.offerCreditPackage.create({
      data: { name: 'Kredi 10', slug: 'kredi-10-truth', creditAmount: 10, priceAmount: 5_000, currency: 'TRY' },
    });
    const purchase = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: provider.id,
        packageId: creditPackage.id,
        creditAmountSnapshot: 10,
        priceAmountSnapshot: 5_000,
        currencySnapshot: 'TRY',
        packageNameSnapshot: creditPackage.name,
      },
    });
    const detail = (await get(await superAdminCookie(), `/package-purchases/${purchase.id}`).expect(200)).body;
    expect(detail.showcaseEntitlement).toBeNull();
  });

  it('puts every stored row in exactly the bucket the status function gives it', async () => {
    const { provider, user } = await vitrinProvider();
    const pkg = await createShowcasePackage(ctx.prisma);
    const day = 24 * 60 * 60 * 1000;
    await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: pkg.id });
    await createShowcaseEntitlement(ctx, {
      providerId: provider.id,
      userId: user.id,
      packageId: pkg.id,
      paidAt: new Date(Date.now() - 200 * day),
    });
    const stored = await createShowcaseEntitlement(ctx, {
      providerId: provider.id,
      userId: user.id,
      packageId: pkg.id,
      paidAt: new Date(Date.now() - 200 * day),
    });
    await ctx.prisma.showcaseEntitlement.update({ where: { id: stored.entitlement.id }, data: { status: 'EXPIRED' } });

    const now = new Date();
    const rows = await ctx.prisma.showcaseEntitlement.findMany();
    for (const status of SHOWCASE_ENTITLEMENT_EFFECTIVE_STATUSES) {
      const matched = await ctx.prisma.showcaseEntitlement.findMany({
        where: showcaseEntitlementEffectiveWhere(status, now),
        select: { id: true },
      });
      const expected = rows.filter((row) => effectiveShowcaseEntitlementStatus(row, now) === status).map((row) => row.id);
      expect(matched.map((row) => row.id).sort(), status).toEqual(expected.sort());
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('C — the dashboard’s vitrin review queue count', () => {
  it('equals the length of the review queue it links to', async () => {
    const { provider, user, category, cookie: providerCookie } = await vitrinProvider();
    const pkg = await createShowcasePackage(ctx.prisma);
    // A card is opened on a right: three rights for three cards.
    for (let i = 0; i < 3; i += 1) {
      await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: pkg.id });
    }
    for (let i = 0; i < 2; i += 1) {
      const created = await request(ctx.server)
        .post(`/providers/${provider.id}/showcase/cards`)
        .set('Cookie', providerCookie)
        .send(showcaseCardPayload(category.id))
        .expect(201);
      await request(ctx.server)
        .post(`/providers/${provider.id}/showcase/cards/${created.body.id}/submit`)
        .set('Cookie', providerCookie)
        .send(SHOWCASE_SUBMIT_BODY)
        .expect(200);
    }
    // A draft that was never submitted is not waiting on anybody.
    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', providerCookie)
      .send(showcaseCardPayload(category.id))
      .expect(201);

    const cookie = await superAdminCookie();
    const queue = (await get(cookie, '/admin/showcase/versions').expect(200)).body as unknown[];
    const summary = (await get(cookie, '/dashboard/admin-summary').expect(200)).body;
    expect(queue).toHaveLength(2);
    expect(summary.pendingShowcaseReviews).toBe(queue.length);
  });

  it('is zero, not absent, on an empty queue for a session that may read it', async () => {
    const summary = (await get(await superAdminCookie(), '/dashboard/admin-summary').expect(200)).body;
    expect(summary.pendingShowcaseReviews).toBe(0);
  });

  it('is left out for a session that may not open the queue', async () => {
    const cookie = await sessionWith([AdminPermission.DASHBOARD_READ]);
    const summary = (await get(cookie, '/dashboard/admin-summary').expect(200)).body;
    expect(summary).not.toHaveProperty('pendingShowcaseReviews');
    expect(summary).not.toHaveProperty('reportedRequests');

    const reader = await sessionWith([AdminPermission.DASHBOARD_READ, AdminPermission.SHOWCASE_REVIEW_READ]);
    const readable = (await get(reader, '/dashboard/admin-summary').expect(200)).body;
    expect(readable.pendingShowcaseReviews).toBe(0);
    expect(readable).not.toHaveProperty('reportedRequests');
  });
});

/* ------------------------------------------------------------------------ */

describe('D — the dashboard counts reported requests, one per request', () => {
  async function reporters(count: number) {
    const category = await createCategory(ctx.prisma);
    const providers = [];
    for (let i = 0; i < count; i += 1) {
      providers.push(await createDiscoverableProvider(ctx.prisma, { categoryId: category.id }));
    }
    return { category, providers };
  }

  function report(requestId: string, providerId: string) {
    return ctx.prisma.serviceRequestReport.create({
      data: { requestId, reporterProviderId: providerId, reason: ServiceRequestReportReason.SPAM },
    });
  }

  async function figures(cookie: string) {
    const summary = (await get(cookie, '/dashboard/admin-summary').expect(200)).body;
    const queue = (await get(cookie, '/service-requests/reports?state=open').expect(200)).body;
    return { summary, queue };
  }

  it('counts two reports on one request as one reported request', async () => {
    const { category, providers } = await reporters(2);
    const one = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await report(one.id, providers[0]!.id);
    await report(one.id, providers[1]!.id);

    const { summary, queue } = await figures(await superAdminCookie());
    expect(summary.reportedRequests).toBe(1);
    expect(summary.openRequestReports).toBe(2);
    expect(queue.total).toBe(1);
    expect(queue.items).toHaveLength(1);
  });

  it('counts two reported requests as two', async () => {
    const { category, providers } = await reporters(1);
    const first = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const second = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await report(first.id, providers[0]!.id);
    await report(second.id, providers[0]!.id);

    const { summary, queue } = await figures(await superAdminCookie());
    expect(summary.reportedRequests).toBe(2);
    expect(queue.total).toBe(2);
  });

  it('leaves a resolved report out, and keeps a request with one still open', async () => {
    const { category, providers } = await reporters(2);
    const resolvedOnly = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const mixed = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const done = { resolvedAt: new Date(), resolvedByUserId: admin.id, resolution: ServiceRequestReportResolution.DISMISSED };
    await ctx.prisma.serviceRequestReport.create({
      data: { requestId: resolvedOnly.id, reporterProviderId: providers[0]!.id, reason: ServiceRequestReportReason.SPAM, ...done },
    });
    await ctx.prisma.serviceRequestReport.create({
      data: { requestId: mixed.id, reporterProviderId: providers[0]!.id, reason: ServiceRequestReportReason.SPAM, ...done },
    });
    await report(mixed.id, providers[1]!.id);

    const { summary, queue } = await figures(await loginAs(ctx.prisma, admin.id));
    expect(summary.reportedRequests).toBe(1);
    expect(queue.total).toBe(1);
    expect(queue.items.map((item: { request: { id: string } }) => item.request.id)).toEqual([mixed.id]);
    const resolved = (await get(await superAdminCookie(), '/service-requests/reports?state=resolved').expect(200)).body;
    expect(resolved.total).toBe(2);
  });

  it('keeps the queue total whole when the queue is paged', async () => {
    const { category, providers } = await reporters(1);
    for (let i = 0; i < 3; i += 1) {
      const reported = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
      await report(reported.id, providers[0]!.id);
    }
    const page = (await get(await superAdminCookie(), '/service-requests/reports?state=open&limit=2').expect(200)).body;
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(page.total).toBe(3);
  });
});

/* ------------------------------------------------------------------------ */

describe('E — the refund scan is paged and its total is the dashboard’s count', () => {
  const CANDIDATES = 125;

  /**
   * One offer made through the real endpoint, so its credit spend and refund
   * schedule are the product's own; then `CANDIDATES - 1` copies of it on
   * their own requests, backdated past their moment, written straight to the
   * table — 125 offers through HTTP would be the slow way to the same rows.
   */
  async function manyCandidates() {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    await grantCredits(ctx.prisma, provider.id, 10);
    const first = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${first.id}/offers`)
      .set('Cookie', await loginAs(ctx.prisma, owner.id))
      .send(offerPayload())
      .expect(201);
    const template = await backdateOfferSubmission(ctx.prisma, created.body.id as string, 200);

    const { id: _id, offerNumber: _number, requestId: _request, ...copy } = template;
    for (let i = 1; i < CANDIDATES; i += 1) {
      const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
      // Two offers per instant, so the id has to break the tie.
      const submittedAt = new Date(template.submittedAt.getTime() + Math.floor(i / 2) * 1000);
      await ctx.prisma.offer.create({
        data: {
          ...copy,
          requestId: serviceRequest.id,
          submittedAt,
          unviewedRefundEligibleAt: new Date(submittedAt.getTime() + (template.unviewedRefundWindowHours ?? 48) * 3_600_000),
        } as never,
      });
    }
  }

  type ScanItem = { offerId: string; creditCost: number };

  it('pages more than 100 candidates with no duplicate and no gap, and totals them all', async () => {
    await manyCandidates();
    const cookie = await superAdminCookie();

    const first = (await get(cookie, '/offers/refund-scan?page=1&pageSize=100').expect(200)).body;
    const second = (await get(cookie, '/offers/refund-scan?page=2&pageSize=100').expect(200)).body;
    expect(first).toMatchObject({ total: CANDIDATES, eligibleCount: CANDIDATES, page: 1, pageSize: 100, hasNextPage: true });
    expect(first.items).toHaveLength(100);
    expect(second).toMatchObject({ total: CANDIDATES, page: 2, hasNextPage: false });
    expect(second.items).toHaveLength(CANDIDATES - 100);
    expect(first.totalCreditCost).toBe(CANDIDATES * 2);

    const ids = [...first.items, ...second.items].map((item: ScanItem) => item.offerId);
    expect(new Set(ids).size).toBe(CANDIDATES);
    const all = await ctx.prisma.offer.findMany({
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(ids).toEqual(all.map((offer) => offer.id));

    const summary = (await get(cookie, '/dashboard/admin-summary').expect(200)).body;
    expect(summary.refundableOffers).toBe(first.total);
  });

  it('defaults to a bounded page and refuses a page beyond the bound', async () => {
    await manyCandidates();
    const cookie = await superAdminCookie();
    const page = (await get(cookie, '/offers/refund-scan').expect(200)).body;
    expect(page).toMatchObject({ page: 1, pageSize: 50, total: CANDIDATES, hasNextPage: true });
    expect(page.items).toHaveLength(50);
    await get(cookie, '/offers/refund-scan?pageSize=101').expect(400);
    await get(cookie, '/offers/refund-scan?limit=100').expect(400);
  });

  it('drops a candidate from the total and the dashboard together once it is viewed or refunded', async () => {
    await manyCandidates();
    const cookie = await superAdminCookie();
    const [viewed, blocked] = await ctx.prisma.offer.findMany({ take: 2, orderBy: { id: 'asc' } });
    await ctx.prisma.offer.update({ where: { id: viewed!.id }, data: { viewedAt: new Date() } });
    await ctx.prisma.offer.update({
      where: { id: blocked!.id },
      data: { refundBlockedAt: new Date(), refundBlockedReason: 'ADMIN_CUSTOMER_DECISION' },
    });

    const scan = (await get(cookie, '/offers/refund-scan?pageSize=100').expect(200)).body;
    const summary = (await get(cookie, '/dashboard/admin-summary').expect(200)).body;
    expect(scan.total).toBe(CANDIDATES - 2);
    expect(summary.refundableOffers).toBe(scan.total);
  });
});
