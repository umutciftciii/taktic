import { AdminPermission, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_ADMIN_PERMISSIONS } from '../src/modules/auth/admin-permissions';
import {
  createAdminWithPermissions,
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * The unreleased catalogue is a permission, not a query parameter.
 *
 * Before this, DRAFT and INACTIVE categories were the same two public
 * endpoints widened by `?includeInactive=true` for a caller who passed a
 * check — so "what anyone may see" and "what the marketplace has not announced
 * yet" were separated by a string in the URL and a function somebody had to
 * remember to call. They are now different routes, and the public ones have no
 * parameter that widens them: there is nothing to spoof because there is
 * nothing to pass.
 *
 * Every case below is one clause of that contract.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

const cookie = (header: string) => header;

type Seeded = { active: string; draft: string; inactive: string };

async function seedCatalogue(): Promise<Seeded> {
  const suffix = uniqueSuffix();
  const active = await createCategory(ctx.prisma, `Yayında ${suffix}`, {
    status: ServiceCategoryStatus.ACTIVE,
    isActive: true,
  });
  const draft = await createCategory(ctx.prisma, `Taslak ${suffix}`, {
    status: ServiceCategoryStatus.DRAFT,
    isActive: false,
  });
  const inactive = await createCategory(ctx.prisma, `Kapalı ${suffix}`, {
    status: ServiceCategoryStatus.INACTIVE,
    isActive: false,
  });

  const rows = await ctx.prisma.serviceCategory.findMany({
    where: { id: { in: [active.id, draft.id, inactive.id] } },
    select: { id: true, slug: true },
  });
  const slugOf = (id: string) => rows.find((row) => row.id === id)!.slug;

  return { active: slugOf(active.id), draft: slugOf(draft.id), inactive: slugOf(inactive.id) };
}

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

describe('the public catalogue endpoint', () => {
  it('returns only what is publicly visible, however the query is written', async () => {
    const seeded = await seedCatalogue();

    // Every spelling somebody might reach for, including the one that used to
    // work. None of them is a parameter this route reads any more.
    const spoofs = [
      '/categories',
      '/categories?includeInactive=true',
      '/categories?includeInactive=TRUE',
      '/categories?includeInactive=1',
      '/categories?includeinactive=true',
      '/categories?includeInactive=true&includeInactive=true',
      '/categories?isSuperAdmin=true',
      '/categories?status=DRAFT',
    ];

    for (const path of spoofs) {
      const response = await request(ctx.server).get(path);
      expect(response.status, path).toBe(200);
      const slugs = (response.body as { slug: string }[]).map((row) => row.slug);
      expect(slugs, path).toContain(seeded.active);
      expect(slugs, path).not.toContain(seeded.draft);
      expect(slugs, path).not.toContain(seeded.inactive);
    }
  });

  it('will not serve an unreleased category by slug either', async () => {
    const seeded = await seedCatalogue();

    for (const slug of [seeded.draft, seeded.inactive]) {
      for (const suffix of ['', '?includeInactive=true']) {
        const response = await request(ctx.server).get(`/categories/${slug}${suffix}`);
        expect(response.status, `${slug}${suffix}`).toBe(404);
      }
    }
  });

  it('stays narrow for a customer, a provider and a staff account without CATALOG_READ', async () => {
    const seeded = await seedCatalogue();

    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    // Every permission there is *except* the one that opens the catalogue.
    const { admin } = await createAdminWithPermissions(
      ctx.prisma,
      ALL_ADMIN_PERMISSIONS.filter((permission) => permission !== AdminPermission.CATALOG_READ),
    );

    for (const user of [customer, provider, admin]) {
      const session = await loginAs(ctx.prisma, user.id);
      const response = await request(ctx.server)
        .get('/categories?includeInactive=true')
        .set('Cookie', cookie(session));

      expect(response.status).toBe(200);
      const slugs = (response.body as { slug: string }[]).map((row) => row.slug);
      expect(slugs).not.toContain(seeded.draft);
      expect(slugs).not.toContain(seeded.inactive);
    }
  });

  it('will not walk a routed flow into an unreleased target, for anybody', async () => {
    // The routing walk used to widen for a signed-in operator, which made it a
    // second door onto the unreleased catalogue — and one nobody would think to
    // check when asking "what leaks a draft". An operator reads the wiring
    // through the admin route instead.
    const seeded = await seedCatalogue();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [...ALL_ADMIN_PERMISSIONS]);
    const session = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server)
      .post('/categories/routing/resolve')
      .set('Cookie', cookie(session))
      .send({ categorySlug: seeded.draft, selections: [] });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).not.toContain(seeded.draft);
  });
});

describe('the admin catalogue endpoint', () => {
  it('refuses a staff account that does not hold CATALOG_READ', async () => {
    await seedCatalogue();
    const { admin } = await createAdminWithPermissions(
      ctx.prisma,
      ALL_ADMIN_PERMISSIONS.filter((permission) => permission !== AdminPermission.CATALOG_READ),
    );
    const session = await loginAs(ctx.prisma, admin.id);

    for (const path of ['/admin/categories', '/admin/categories/anything']) {
      const response = await request(ctx.server).get(path).set('Cookie', cookie(session));
      expect(response.status, path).toBe(403);
      expect(response.body.code, path).toBe('INSUFFICIENT_PERMISSION');
    }
  });

  it('refuses a customer, a provider and an anonymous caller', async () => {
    await seedCatalogue();

    const anonymous = await request(ctx.server).get('/admin/categories');
    expect(anonymous.status).toBe(401);

    for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER] as const) {
      const user = await createUser(ctx.prisma, { role });
      const session = await loginAs(ctx.prisma, user.id);
      const response = await request(ctx.server)
        .get('/admin/categories')
        .set('Cookie', cookie(session));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('NOT_STAFF');
    }
  });

  it('serves the whole catalogue to a staff account that holds CATALOG_READ', async () => {
    const seeded = await seedCatalogue();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATALOG_READ]);
    const session = await loginAs(ctx.prisma, admin.id);

    const list = await request(ctx.server).get('/admin/categories').set('Cookie', cookie(session));
    expect(list.status).toBe(200);
    const slugs = (list.body as { slug: string }[]).map((row) => row.slug);
    expect(slugs).toEqual(expect.arrayContaining([seeded.active, seeded.draft, seeded.inactive]));

    const detail = await request(ctx.server)
      .get(`/admin/categories/${seeded.draft}`)
      .set('Cookie', cookie(session));
    expect(detail.status).toBe(200);
    expect(detail.body.slug).toBe(seeded.draft);
  });

  it('serves it to a SUPER_ADMIN with no role assignment at all', async () => {
    const seeded = await seedCatalogue();
    const superAdmin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const session = await loginAs(ctx.prisma, superAdmin.id);

    const response = await request(ctx.server)
      .get('/admin/categories')
      .set('Cookie', cookie(session));

    expect(response.status).toBe(200);
    expect((response.body as { slug: string }[]).map((row) => row.slug)).toContain(seeded.draft);
  });
});

describe('reading the catalogue is not writing it', () => {
  it('refuses every write to a holder of CATALOG_READ alone', async () => {
    const seeded = await seedCatalogue();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATALOG_READ]);
    const session = await loginAs(ctx.prisma, admin.id);

    const draft = await ctx.prisma.serviceCategory.findFirstOrThrow({
      where: { slug: seeded.draft },
      select: { id: true, name: true, status: true },
    });

    // Thunks, not promises: supertest binds an ephemeral port per request, and
    // an array of already-started requests races them against each other.
    const writes: (() => Promise<{ status: number; body: { code?: string } }>)[] = [
      () => request(ctx.server).post('/categories').set('Cookie', cookie(session)).send({ name: 'Yeni' }),
      () =>
        request(ctx.server)
          .patch(`/categories/${draft.id}`)
          .set('Cookie', cookie(session))
          .send({ name: 'Değişti' }),
      () =>
        request(ctx.server)
          .patch(`/categories/${draft.id}/status`)
          .set('Cookie', cookie(session))
          .send({ status: 'ACTIVE' }),
      () => request(ctx.server).delete(`/categories/${draft.id}`).set('Cookie', cookie(session)),
    ];

    for (const write of writes) {
      const response = await write();
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_PERMISSION');
    }

    const unchanged = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: draft.id },
      select: { name: true, status: true },
    });
    expect(unchanged).toEqual({ name: draft.name, status: draft.status });
  });
});

describe('no other route leaks an unreleased category', () => {
  it('keeps the provider-enrollment list to its own narrow projection', async () => {
    /*
     * The one deliberate exception, and it is not the catalogue.
     *
     * `GET /categories/provider-enrollment` exists so a business whose trade is
     * in the next wave can still apply, so it does name categories that are not
     * live — by its own predicate, not by a widening. What matters is that it
     * stays a *different* thing: a name, a slug and an availability flag, and
     * none of the fields the operator's view carries.
     */
    await seedCatalogue();
    const response = await request(ctx.server).get('/categories/provider-enrollment');

    expect(response.status).toBe(200);
    for (const row of response.body as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('status');
      expect(row).not.toHaveProperty('isActive');
      expect(row).not.toHaveProperty('questions');
      expect(row).not.toHaveProperty('children');
    }
  });

  it('has exactly one route that serves the unreleased catalogue', async () => {
    // A guard against the next widening: if somebody adds `includeInactive`
    // back, or opens a second door, the map and this assertion disagree.
    const { ADMIN_ROUTE_PERMISSIONS } = await import('../src/modules/auth/route-permission-map');
    const catalogueRoutes = ADMIN_ROUTE_PERMISSIONS.filter(
      (entry) => entry.permission === AdminPermission.CATALOG_READ,
    );

    expect(catalogueRoutes.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([
      'GET /admin/categories',
      'GET /admin/categories/:slug',
    ]);
  });
});
