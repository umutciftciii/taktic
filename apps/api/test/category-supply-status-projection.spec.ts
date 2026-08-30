import {
  ProviderStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * The readiness figure an operator signs a release off on, over HTTP.
 *
 * The matrix itself is pinned without a database in
 * category-supply-status.spec.ts. What this file owns is the two things only
 * the wire can show: that the value follows the data with no re-binding and no
 * migration, and that it reaches nobody but an operator.
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
  ctx.notifications.clear();
});

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

/** The status exactly as the readiness panel reads it, from the listing. */
async function supplyStatusOf(cookie: string, slug: string) {
  const response = await request(ctx.server)
    .get('/categories?includeInactive=true')
    .set('Cookie', cookie)
    .expect(200);

  const row = (response.body as Array<{ slug: string; supplyStatus: string | null }>).find(
    (entry) => entry.slug === slug,
  );

  expect(row).toBeDefined();
  return row!.supplyStatus;
}

describe('category supply status over HTTP', () => {
  it('moves from EMPTY to SUPPLY_READY when an approved provider is bound, and to LAUNCH_READY once priced', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: null,
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');

    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('SUPPLY_READY');

    await ctx.prisma.serviceCategory.update({
      where: { id: category.id },
      data: { offerCreditCost: 4 },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');
  });

  it('stays EMPTY for a provider under review and moves on its own once approved', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
    });

    const provider = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.PENDING_REVIEW,
    });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');

    // No re-binding and no migration: approving the provider is the whole event.
    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.APPROVED },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');
  });

  it('falls back when the approval is withdrawn and when the binding is removed', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
    });

    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const binding = await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');

    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.SUSPENDED },
    });
    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');

    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.APPROVED },
    });
    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');

    await ctx.prisma.providerServiceCategory.delete({ where: { id: binding.id } });
    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');
  });

  it('says LIVE for a released service and nothing at all for groups, routers and closed categories', async () => {
    const cookie = await adminCookie();
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });
    const router = await createCategory(ctx.prisma, 'Yonlendirici', {
      kind: ServiceCategoryKind.ROUTER,
      status: ServiceCategoryStatus.DRAFT,
    });
    const closed = await createCategory(ctx.prisma, 'Kapali', {
      status: ServiceCategoryStatus.INACTIVE,
    });

    expect(await supplyStatusOf(cookie, live.slug)).toBe('LIVE');
    expect(await supplyStatusOf(cookie, group.slug)).toBeNull();
    expect(await supplyStatusOf(cookie, router.slug)).toBeNull();
    expect(await supplyStatusOf(cookie, closed.slug)).toBeNull();
  });

  it('travels on the operator detail view too', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
    });

    const response = await request(ctx.server)
      .get(`/categories/${category.slug}?includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.supplyStatus).toBe('EMPTY');
  });

  it('reaches nobody but an operator', async () => {
    const category = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });

    const list = await request(ctx.server).get('/categories').expect(200);
    for (const row of list.body as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('supplyStatus');
      expect(row).not.toHaveProperty('approvedProviderCount');
      // Whether the marketplace is recruiting for a service is an operational
      // decision with no reader on the customer catalogue. It reached the wire
      // once because the public query returns every scalar column, which is a
      // way for a schema change to publish a field nobody chose to publish.
      expect(row).not.toHaveProperty('providerEnrollmentOpen');
      expect((row._count as Record<string, unknown> | undefined) ?? {}).not.toHaveProperty(
        'providers',
      );
    }

    const detail = await request(ctx.server).get(`/categories/${category.slug}`).expect(200);
    expect(detail.body).not.toHaveProperty('supplyStatus');
    expect(detail.body).not.toHaveProperty('approvedProviderCount');
    expect(detail.body).not.toHaveProperty('providerEnrollmentOpen');
    expect(detail.body._count ?? {}).not.toHaveProperty('providers');

    // The fields a client written before any of this already reads are still
    // there. The narrowing removes one column and must not become a rewrite of
    // the public shape.
    for (const kept of ['id', 'name', 'slug', 'kind', 'status', 'isActive', 'sortOrder']) {
      expect(detail.body, kept).toHaveProperty(kept);
    }

    // A signed-in customer is still the public projection.
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const asCustomer = await request(ctx.server)
      .get('/categories')
      .set('Cookie', customerCookie)
      .expect(200);
    for (const row of asCustomer.body as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('supplyStatus');
    }

    // And asking for the wide view without being an operator is still refused.
    await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', customerCookie)
      .expect(403);
  });
});

describe('a LAUNCH_READY draft is still a draft', () => {
  it('stays out of the public catalogue, refuses requests and mails nobody', async () => {
    const category = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
      providerEnrollmentOpen: true,
    });

    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: provider.id, city: 'İstanbul', district: 'Kadıköy' },
    });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    // It is LAUNCH_READY on the operator's panel...
    const cookie = await adminCookie();
    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');

    // ...and nothing else about it has moved.
    const list = await request(ctx.server).get('/categories').expect(200);
    expect((list.body as Array<{ slug: string }>).map((row) => row.slug)).not.toContain(
      category.slug,
    );

    await request(ctx.server).get(`/categories/${category.slug}`).expect(404);

    // 404 rather than 403: an unreleased category is simply not there for
    // anybody who may not use it, and a distinguishable refusal would confirm
    // the slug of an unreleased service to whoever guessed it.
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', customerCookie)
      .send(serviceRequestPayload(category.slug))
      .expect(404);

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(404);

    // No request means no matching, no offer and no fan-out. The mail spy is
    // the honest check that the last one did not happen.
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  /**
   * The same closure from the other side: not "no request could be made", but
   * "a request that exists reaches nobody".
   *
   * provider-draft-category-binding.spec.ts pins this for a draft an operator
   * bound somebody to. This is the case that is new — a provider who signed
   * *themselves* up, to a draft that is open, priced and staffed — and the
   * answer has to be identical, because enrollment is recruitment and never
   * release.
   */
  it('reaches no provider even when one joined it and an admin opened a request on it', async () => {
    const category = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
      providerEnrollmentOpen: true,
    });

    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const provider = await createProviderProfile(ctx.prisma, {
      userId: owner.id,
      status: ProviderStatus.APPROVED,
    });
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: provider.id, city: 'İstanbul', district: 'Kadıköy' },
    });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });
    await grantCredits(ctx.prisma, provider.id, 10);

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    ctx.notifications.clear();

    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body).toEqual([]);

    // 404 rather than 403, like every other request a provider may not see: a
    // refusal that distinguished them would confirm the request exists.
    await request(ctx.server)
      .get(`/providers/${provider.id}/requests/${serviceRequest.id}`)
      .set('Cookie', cookie)
      .expect(404);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(404);

    expect(await ctx.prisma.offer.count({ where: { providerId: provider.id } })).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);

    // And the public profile still says nothing about the service they joined.
    const publicProfile = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .expect(200);
    expect(publicProfile.body.visibility).toBe('public');
    expect(publicProfile.body).not.toHaveProperty('upcomingServiceCategories');
    expect(JSON.stringify(publicProfile.body)).not.toContain(category.slug);
  });
});
