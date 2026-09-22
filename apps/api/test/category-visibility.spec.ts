import {
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createCategory,
  createSelectQuestion,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import { AdminPermission } from '@prisma/client';
import { ALL_ADMIN_PERMISSIONS } from '../src/modules/auth/admin-permissions';

/**
 * Who may read an unreleased category.
 *
 * The operator's view of the taxonomy — every DRAFT service the marketplace is
 * preparing, every category it has closed, the groups and routers that are
 * navigation rather than services, and the questions and routing destinations
 * behind all of them.
 *
 * It has been three different things. First a plain `?includeInactive=true` on
 * two public endpoints, readable by anybody who typed it. Then the same
 * parameter behind a check, which made the boundary between the announced
 * catalogue and the unannounced one a string in the URL. It is now
 * `GET /admin/categories`, behind `CATALOG_READ` — a different route, with no
 * parameter that widens the public ones.
 *
 * These cases pin the access matrix down at the HTTP boundary, because the
 * claim is about what a stranger can fetch — not about what a service method
 * returns when a caller passes it the right boolean.
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

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

async function cookieFor(role: UserRole) {
  const user = await createUser(ctx.prisma, { role });
  return loginAs(ctx.prisma, user.id);
}

/**
 * One unreleased service, with a question on it, plus the shapes that are
 * public. Every leak assertion below is about the first three never appearing
 * anywhere in a response body.
 */
async function unreleasedFixture() {
  const draft = await createCategory(ctx.prisma, 'Gizli Taslak Hizmet', {
    status: ServiceCategoryStatus.DRAFT,
  });
  const draftQuestion = await createSelectQuestion(ctx.prisma, {
    categoryId: draft.id,
    key: 'gizli_soru',
    label: 'Yayınlanmamış hizmetin sorusu',
    options: [{ key: 'a', label: 'A' }],
  });
  const closed = await createCategory(ctx.prisma, 'Kapatılmış Hizmet', {
    status: ServiceCategoryStatus.INACTIVE,
  });
  const group = await createCategory(ctx.prisma, 'Grup', {
    kind: ServiceCategoryKind.GROUP,
  });
  const live = await createCategory(ctx.prisma, 'Yayındaki Hizmet', { offerCreditCost: 1 });

  return { draft, draftQuestion, closed, group, live };
}

/** Nothing about the unreleased taxonomy may appear in `body`, anywhere. */
function expectNoDraftLeak(
  body: unknown,
  fixture: Awaited<ReturnType<typeof unreleasedFixture>>,
) {
  const serialized = JSON.stringify(body ?? null);

  expect(serialized).not.toContain(fixture.draft.slug);
  expect(serialized).not.toContain(fixture.draft.name);
  expect(serialized).not.toContain(fixture.draftQuestion.key);
  expect(serialized).not.toContain(fixture.draftQuestion.label);
  expect(serialized).not.toContain(fixture.closed.slug);
  expect(serialized).not.toContain(fixture.group.slug);
  expect(serialized).not.toContain(ServiceCategoryStatus.DRAFT);
}

describe('GET /admin/categories — the operator\'s catalogue', () => {
  it('refuses an anonymous caller and leaks nothing in the refusal', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server).get('/admin/categories');

    // 401 rather than 403: no credential was presented at all, and the answer
    // to that is the sign-in form.
    expect(response.status).toBe(401);
    expectNoDraftLeak(response.body, fixture);
  });

  it('refuses a signed-in CUSTOMER', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/admin/categories')
      .set('Cookie', await cookieFor(UserRole.CUSTOMER));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_STAFF');
    expectNoDraftLeak(response.body, fixture);
  });

  it('refuses a signed-in PROVIDER', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/admin/categories')
      .set('Cookie', await cookieFor(UserRole.PROVIDER));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_STAFF');
    expectNoDraftLeak(response.body, fixture);
  });

  it('refuses a staff account holding every permission except CATALOG_READ', async () => {
    const fixture = await unreleasedFixture();
    const { admin } = await createAdminWithPermissions(
      ctx.prisma,
      ALL_ADMIN_PERMISSIONS.filter((permission) => permission !== AdminPermission.CATALOG_READ),
    );

    const response = await request(ctx.server)
      .get('/admin/categories')
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    // Being staff is not the same statement as being allowed to see what the
    // marketplace has not announced yet.
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_PERMISSION');
    expectNoDraftLeak(response.body, fixture);
  });

  it('serves the whole tree to a holder of CATALOG_READ', async () => {
    const fixture = await unreleasedFixture();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATALOG_READ]);

    const response = await request(ctx.server)
      .get('/admin/categories')
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).toContain(fixture.draft.slug);
    expect(serialized).toContain(fixture.closed.slug);
    expect(serialized).toContain(fixture.group.slug);
    expect(serialized).toContain(fixture.live.slug);
  });

  it('serves it to a SUPER_ADMIN with no role assignment', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/admin/categories')
      .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN));

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain(fixture.draft.slug);
  });

  it('searches the whole tree, not only the public part', async () => {
    const fixture = await unreleasedFixture();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATALOG_READ]);

    const response = await request(ctx.server)
      .get('/admin/categories?q=Gizli')
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain(fixture.draft.slug);
  });
});

describe('GET /admin/categories/:slug', () => {
  it('refuses an anonymous caller', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server).get(`/admin/categories/${fixture.draft.slug}`);

    expect(response.status).toBe(401);
    expectNoDraftLeak(response.body, fixture);
  });

  it('refuses a CUSTOMER and a PROVIDER', async () => {
    const fixture = await unreleasedFixture();

    for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER] as const) {
      const response = await request(ctx.server)
        .get(`/admin/categories/${fixture.draft.slug}`)
        .set('Cookie', await cookieFor(role));

      expect(response.status).toBe(403);
      expectNoDraftLeak(response.body, fixture);
    }
  });

  it('refuses before it looks the slug up, so it cannot confirm one exists', async () => {
    const fixture = await unreleasedFixture();

    const real = await request(ctx.server)
      .get(`/admin/categories/${fixture.draft.slug}`)
      .set('Cookie', await cookieFor(UserRole.CUSTOMER));
    const invented = await request(ctx.server)
      .get('/admin/categories/boyle-bir-sey-yok')
      .set('Cookie', await cookieFor(UserRole.CUSTOMER));

    // The same answer either way: a 403 for one slug and a 404 for another
    // would be an oracle for the unreleased catalogue.
    expect(real.status).toBe(invented.status);
    expect(real.status).toBe(403);
  });

  it('serves the draft and its questions to a holder of CATALOG_READ', async () => {
    const fixture = await unreleasedFixture();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CATALOG_READ]);

    const response = await request(ctx.server)
      .get(`/admin/categories/${fixture.draft.slug}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id));

    expect(response.status).toBe(200);
    expect(response.body.slug).toBe(fixture.draft.slug);
    expect(JSON.stringify(response.body)).toContain(fixture.draftQuestion.key);
  });

  it('still hides a draft behind a 404 on the public route', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server).get(`/categories/${fixture.draft.slug}`);

    expect(response.status).toBe(404);
    expectNoDraftLeak(response.body, fixture);
  });
});

describe('the public routes have no wide mode left', () => {
  it('ignores every spelling of the parameter that used to widen them', async () => {
    const fixture = await unreleasedFixture();

    for (const path of [
      '/categories',
      '/categories?includeInactive=true',
      '/categories?includeInactive=TRUE',
      '/categories?includeInactive=1',
      '/categories?includeinactive=true',
    ]) {
      const response = await request(ctx.server).get(path);
      expect(response.status, path).toBe(200);
      expectNoDraftLeak(response.body, fixture);
    }
  });

  it('ignores it for a SUPER_ADMIN too, because the route no longer reads it', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN));

    // Not a refusal — a narrow answer. The parameter is not a thing any more,
    // so there is nothing to refuse and nothing to grant.
    expect(response.status).toBe(200);
    expectNoDraftLeak(response.body, fixture);
  });

  it('leaves the public catalogue reachable with a dead session cookie', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/categories')
      .set('Cookie', `${COOKIE_NAME}=bu-oturum-yok`);

    // A broken credential is not a reason to hide the public catalogue: this
    // route never looked at the session, and now it has no reason to.
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain(fixture.live.slug);
    expectNoDraftLeak(response.body, fixture);
  });
});
