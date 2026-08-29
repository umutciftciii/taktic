import {
  ProviderStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import {
  createApprovedRequest,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  providerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Binding a provider to a category the marketplace has not released yet.
 *
 * The release decision for a draft service rests on one number — how many
 * approved providers stand behind it — and before this change there was no way
 * for that number to be anything but zero. The category is invisible to
 * providers by design, so nobody could select it; and the only writer of the
 * binding table was the profile form, which refuses anything that is not an
 * ACTIVE leaf. An operator could see the question and could not answer it.
 *
 * So one privilege was added and nothing else: a SUPER_ADMIN may attach a
 * provider to a DRAFT leaf by hand. Everything downstream of that binding is
 * unchanged, which is what most of this file is about — a draft binding feeds
 * the readiness count and touches nothing else. It does not reach discovery,
 * offering, the provider's own profile, their e-mail, or the public page; and
 * the moment the category is released the same row starts counting for all of
 * them with no migration.
 *
 * category-visibility.spec.ts owns the `includeInactive` access matrix; this
 * file owns what a *provider binding* to a draft may and may not do.
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

async function cookieFor(role: UserRole) {
  const user = await createUser(ctx.prisma, { role });
  return loginAs(ctx.prisma, user.id);
}

/** An approved provider with a service area that covers the request fixtures. */
async function approvedProvider(overrides: { userId?: string | null } = {}) {
  const provider = await createProviderProfile(ctx.prisma, {
    userId: overrides.userId ?? null,
    status: ProviderStatus.APPROVED,
  });

  await ctx.prisma.providerServiceArea.create({
    data: { providerId: provider.id, city: 'İstanbul', district: 'Kadıköy' },
  });

  return provider;
}

/** The approved-provider figure exactly as the readiness panel reads it. */
async function readinessCount(adminCookie: string, slug: string): Promise<number> {
  const response = await request(ctx.server)
    .get('/categories?includeInactive=true')
    .set('Cookie', adminCookie)
    .expect(200);

  const category = (response.body as Array<{ slug: string; _count?: { providers?: number } }>).find(
    (entry) => entry.slug === slug,
  );

  return category?._count?.providers ?? 0;
}

describe('POST /providers/:id/service-categories', () => {
  it('attaches an approved provider to a draft leaf and moves the readiness count', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });
    const provider = await approvedProvider();

    expect(await readinessCount(adminCookie, draft.slug)).toBe(0);

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .send({ categoryId: draft.id })
      .expect(201);

    expect(response.body.created).toBe(true);
    expect(response.body.serviceCategories).toHaveLength(1);
    expect(response.body.serviceCategories[0]).toMatchObject({
      categoryId: draft.id,
      countsForRelease: true,
      category: { slug: draft.slug, status: ServiceCategoryStatus.DRAFT },
    });

    // The number a release is signed off against, read back from the endpoint
    // the panel actually calls rather than from the row that was just written.
    expect(await readinessCount(adminCookie, draft.slug)).toBe(1);
  });

  it('is idempotent: the same pair twice is one row', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
    });
    const provider = await approvedProvider();

    const first = await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .send({ categoryId: draft.id })
      .expect(201);
    const second = await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .send({ categoryId: draft.id })
      .expect(201);

    expect(first.body.created).toBe(true);
    // A completed request, not a refusal — and the caller can still tell the
    // two apart, which is what lets the admin screen word them differently.
    expect(second.body.created).toBe(false);
    expect(second.body.serviceCategories).toHaveLength(1);

    const rows = await ctx.prisma.providerServiceCategory.count({
      where: { providerId: provider.id, categoryId: draft.id },
    });
    expect(rows).toBe(1);
    // And the count it feeds does not double either.
    expect(await readinessCount(adminCookie, draft.slug)).toBe(1);
  });

  it('attaches an ACTIVE leaf too, so one screen manages the whole list', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const live = await createCategory(ctx.prisma, 'Yayındaki Hizmet', { offerCreditCost: 2 });
    const provider = await approvedProvider();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .send({ categoryId: live.id })
      .expect(201);

    expect(response.body.created).toBe(true);
    expect(response.body.serviceCategories[0].category.status).toBe(ServiceCategoryStatus.ACTIVE);
  });

  it('refuses a GROUP, a ROUTER and a closed category', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const provider = await approvedProvider();

    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });
    const router = await createCategory(ctx.prisma, 'Yönlendirici', {
      kind: ServiceCategoryKind.ROUTER,
      status: ServiceCategoryStatus.DRAFT,
    });
    const closed = await createCategory(ctx.prisma, 'Kapatılmış Hizmet', {
      status: ServiceCategoryStatus.INACTIVE,
    });

    for (const category of [group, router, closed]) {
      const response = await request(ctx.server)
        .post(`/providers/${provider.id}/service-categories`)
        .set('Cookie', adminCookie)
        .send({ categoryId: category.id })
        .expect(400);

      expect(response.body.code).toBe('CATEGORY_NOT_ASSIGNABLE');
    }

    expect(
      await ctx.prisma.providerServiceCategory.count({ where: { providerId: provider.id } }),
    ).toBe(0);
  });

  it('404s on a category that does not exist, and on a provider that does not', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const provider = await approvedProvider();
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .send({ categoryId: 'kategori-yok' })
      .expect(404);

    await request(ctx.server)
      .post('/providers/hizmet-veren-yok/service-categories')
      .set('Cookie', adminCookie)
      .send({ categoryId: draft.id })
      .expect(404);
  });
});

describe('who may write a provider-category binding', () => {
  /*
   * The privilege is the whole feature, so the refusals are checked at the HTTP
   * boundary for every caller who is not an operator — including the provider
   * the binding is *about*, who is the one account with a plausible claim to it.
   */
  it('refuses an anonymous caller, a CUSTOMER, and a PROVIDER', async () => {
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
    });
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await approvedProvider({ userId: providerUser.id });
    const ownCookie = await loginAs(ctx.prisma, providerUser.id);

    await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .send({ categoryId: draft.id })
      .expect(401);

    await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', await cookieFor(UserRole.CUSTOMER))
      .send({ categoryId: draft.id })
      .expect(403);

    // Not even for their own profile: a provider who could attach themselves to
    // a draft could enumerate the unreleased catalogue by trying ids.
    await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', ownCookie)
      .send({ categoryId: draft.id })
      .expect(403);

    expect(
      await ctx.prisma.providerServiceCategory.count({ where: { providerId: provider.id } }),
    ).toBe(0);
  });

  it('refuses the same three on the delete and on the operator listing', async () => {
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
    });
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await approvedProvider({ userId: providerUser.id });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: draft.id },
    });

    const cookies = [
      null,
      await cookieFor(UserRole.CUSTOMER),
      await loginAs(ctx.prisma, providerUser.id),
    ];

    for (const cookie of cookies) {
      const expected = cookie === null ? 401 : 403;

      const remove = request(ctx.server).delete(
        `/providers/${provider.id}/service-categories/${draft.id}`,
      );
      if (cookie) remove.set('Cookie', cookie);
      const removeResponse = await remove.expect(expected);

      const list = request(ctx.server).get(`/providers/${provider.id}/service-categories`);
      if (cookie) list.set('Cookie', cookie);
      const listResponse = await list.expect(expected);

      // A refusal must not be a slower way of asking the same question.
      expect(JSON.stringify(removeResponse.body)).not.toContain(draft.slug);
      expect(JSON.stringify(listResponse.body)).not.toContain(draft.slug);
    }

    expect(
      await ctx.prisma.providerServiceCategory.count({ where: { providerId: provider.id } }),
    ).toBe(1);
  });
});

describe('DELETE /providers/:id/service-categories/:categoryId', () => {
  it('removes the binding and is idempotent', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
    });
    const provider = await approvedProvider();
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: draft.id },
    });

    const first = await request(ctx.server)
      .delete(`/providers/${provider.id}/service-categories/${draft.id}`)
      .set('Cookie', adminCookie)
      .expect(200);
    const second = await request(ctx.server)
      .delete(`/providers/${provider.id}/service-categories/${draft.id}`)
      .set('Cookie', adminCookie)
      .expect(200);

    expect(first.body.removed).toBe(true);
    expect(second.body.removed).toBe(false);
    expect(second.body.serviceCategories).toEqual([]);
    expect(await readinessCount(adminCookie, draft.slug)).toBe(0);
  });
});

describe('the readiness count only counts approved providers', () => {
  it.each([ProviderStatus.PENDING_REVIEW, ProviderStatus.SUSPENDED, ProviderStatus.REJECTED])(
    'a %s provider may be bound but does not count',
    async (status) => {
      const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
      const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
        status: ServiceCategoryStatus.DRAFT,
        offerCreditCost: 2,
      });
      const provider = await createProviderProfile(ctx.prisma, { status });

      const response = await request(ctx.server)
        .post(`/providers/${provider.id}/service-categories`)
        .set('Cookie', adminCookie)
        .send({ categoryId: draft.id })
        .expect(201);

      // Bound, and honest about being inert: the screen has to be able to say
      // "this changed nothing yet" rather than leave the operator wondering
      // why the panel still reads zero.
      expect(response.body.serviceCategories[0].countsForRelease).toBe(false);
      expect(response.body.providerStatus).toBe(status);
      expect(await readinessCount(adminCookie, draft.slug)).toBe(0);
    },
  );

  it('starts counting when the provider is approved, with no re-binding', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 2,
    });
    const provider = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.PENDING_REVIEW,
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .send({ categoryId: draft.id })
      .expect(201);
    expect(await readinessCount(adminCookie, draft.slug)).toBe(0);

    await request(ctx.server)
      .patch(`/providers/${provider.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ProviderStatus.APPROVED })
      .expect(200);

    expect(await readinessCount(adminCookie, draft.slug)).toBe(1);
  });
});

describe('a draft binding never reaches the provider', () => {
  /**
   * One provider account, bound by an operator to a draft *and* to a live
   * category. Every assertion below is that the live one is present and the
   * draft one is absent — a fixture with only the draft could pass by returning
   * nothing at all.
   */
  async function boundProvider() {
    const draft = await createCategory(ctx.prisma, 'Gizli Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });
    const live = await createCategory(ctx.prisma, 'Yayındaki Hizmet', { offerCreditCost: 2 });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await approvedProvider({ userId: user.id });

    await ctx.prisma.providerServiceCategory.createMany({
      data: [
        { providerId: provider.id, categoryId: draft.id },
        { providerId: provider.id, categoryId: live.id },
      ],
    });

    return { draft, live, provider, cookie: await loginAs(ctx.prisma, user.id) };
  }

  /** Nothing that names the draft may appear in `body`, anywhere in it. */
  function expectNoDraftLeak(body: unknown, draft: { slug: string; name: string; id: string }) {
    const serialized = JSON.stringify(body ?? null);
    expect(serialized).not.toContain(draft.slug);
    expect(serialized).not.toContain(draft.name);
    expect(serialized).not.toContain(draft.id);
  }

  it('is absent from GET /providers/me', async () => {
    const { draft, live, cookie } = await boundProvider();

    const response = await request(ctx.server)
      .get('/providers/me')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.serviceCategories).toHaveLength(1);
    expect(response.body.serviceCategories[0].category.slug).toBe(live.slug);
    expectNoDraftLeak(response.body, draft);
  });

  it('is absent from the provider dashboard', async () => {
    const { draft, live, cookie } = await boundProvider();

    const response = await request(ctx.server)
      .get('/providers/me/dashboard')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.provider.serviceCategories.map((entry: any) => entry.category.slug)).toEqual(
      [live.slug],
    );
    expectNoDraftLeak(response.body, draft);
  });

  it("is absent from the provider's own profile read", async () => {
    const { draft, live, provider, cookie } = await boundProvider();

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.visibility).toBe('owner');
    expect(response.body.serviceCategories.map((entry: any) => entry.category.slug)).toEqual([
      live.slug,
    ]);
    expectNoDraftLeak(response.body, draft);
  });

  it('is absent from the public profile, signed out and as a customer', async () => {
    const { draft, live, provider } = await boundProvider();

    for (const cookie of [null, await cookieFor(UserRole.CUSTOMER)]) {
      const call = request(ctx.server).get(`/providers/${provider.id}`);
      if (cookie) call.set('Cookie', cookie);
      const response = await call.expect(200);

      expect(response.body.visibility).toBe('public');
      expect(response.body.serviceCategories.map((entry: any) => entry.category.slug)).toEqual([
        live.slug,
      ]);
      expectNoDraftLeak(response.body, draft);
    }
  });

  it('is present for a SUPER_ADMIN, which is the point of the binding', async () => {
    const { draft, live, provider } = await boundProvider();
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);

    const detail = await request(ctx.server)
      .get(`/providers/${provider.id}/admin-detail`)
      .set('Cookie', adminCookie)
      .expect(200);
    const bindings = await request(ctx.server)
      .get(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .expect(200);

    expect(
      detail.body.serviceCategories.map((entry: any) => entry.category.slug).sort(),
    ).toEqual([draft.slug, live.slug].sort());
    expect(bindings.body.serviceCategories.map((entry: any) => entry.category.slug).sort()).toEqual(
      [draft.slug, live.slug].sort(),
    );
  });

  it('survives the provider saving their own profile', async () => {
    // The form the provider submits never offered the draft, so an absent id
    // means "I was never shown this" — not "remove it". A save that dropped the
    // binding would silently undo the operator's preparation.
    const { draft, live, provider, cookie } = await boundProvider();

    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([live.id]), businessName: 'Yeni Ad' })
      .expect(200);

    expect(response.body.serviceCategories.map((entry: any) => entry.category.slug)).toEqual([
      live.slug,
    ]);
    expectNoDraftLeak(response.body, draft);

    const stored = await ctx.prisma.providerServiceCategory.findMany({
      where: { providerId: provider.id },
      select: { categoryId: true },
    });
    expect(stored.map((row) => row.categoryId).sort()).toEqual([draft.id, live.id].sort());
  });

  it('cannot be created through the profile form, whoever submits it', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
    });

    // The route a provider can reach keeps refusing a draft id even when the
    // caller is the one role allowed to bind one — the privilege belongs to the
    // dedicated endpoint, not to a field on the profile payload.
    await request(ctx.server)
      .post('/providers')
      .send(providerPayload([draft.id]))
      .expect(400);

    const provider = await approvedProvider();
    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', adminCookie)
      .send(providerPayload([draft.id]))
      .expect(400);
  });
});

describe('a draft binding is not supply', () => {
  /**
   * A draft category with an admin's smoke-test request on it, and an approved
   * provider bound to that category. Everything below is that the request stays
   * out of the provider's reach until the category is released.
   */
  async function draftWithRequest() {
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await approvedProvider({ userId: user.id });
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 2,
    });

    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: draft.id },
    });
    await grantCredits(ctx.prisma, provider.id, 10);

    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: draft.id });

    return { provider, draft, serviceRequest, cookie: await loginAs(ctx.prisma, user.id) };
  }

  it('keeps the draft category out of discovery, detail and offering', async () => {
    const { provider, draft, serviceRequest, cookie } = await draftWithRequest();

    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain(draft.slug);

    // 404 rather than 403, like every other request the provider may not see:
    // a refusal that distinguishes them would confirm the request exists.
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
  });

  it('becomes discoverable the moment the category is released, with no re-binding', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const { provider, draft, serviceRequest, cookie } = await draftWithRequest();

    await request(ctx.server)
      .patch(`/categories/${draft.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.ACTIVE })
      .expect(200);

    const list = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);

    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(serviceRequest.id);

    // The same row that was inert a moment ago is now the provider's own
    // category, visible to them on their own profile.
    const profile = await request(ctx.server)
      .get('/providers/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(profile.body.serviceCategories.map((entry: any) => entry.category.slug)).toEqual([
      draft.slug,
    ]);

    // And they can offer on it, which is the end of the chain the binding was
    // preparation for.
    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);
  });

  it('keeps the provider out of the approval fan-out until the category is released', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const { draft, serviceRequest } = await draftWithRequest();
    const mail = ctx.app.get(TransactionalMailService);

    // A draft category's requests are the operator's own smoke tests. Mailing
    // one out would hand a provider a request they cannot open — and put an
    // unreleased service's name in their inbox, which is the leak that survives
    // every screen-level check because it is not on a screen.
    const before = await mail.fanOutApprovedRequest(serviceRequest.id, new Date());
    expect(before.reached).toBe(0);
    // Scoped to the provider half of the fan-out. The customer's own
    // "your request is live" message names the category and always has — they
    // are the one who filed it — so a check over every message would be
    // asserting something this rule was never about.
    expect(ctx.notifications.ofTemplate('request-available')).toEqual([]);

    await request(ctx.server)
      .patch(`/categories/${draft.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.ACTIVE })
      .expect(200);

    const after = await mail.fanOutApprovedRequest(serviceRequest.id, new Date());
    expect(after.reached).toBe(1);
  });

  it('closing the category refuses new offers by the rule that already existed', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const { provider, draft, serviceRequest, cookie } = await draftWithRequest();

    await request(ctx.server)
      .patch(`/categories/${draft.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.ACTIVE })
      .expect(200);
    await request(ctx.server)
      .patch(`/categories/${draft.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.INACTIVE })
      .expect(200);

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(409);

    expect(response.body.code).toBe('CATEGORY_INACTIVE');
  });
});
