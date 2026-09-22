import { AdminPermission, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_ADMIN_PERMISSIONS } from '../src/modules/auth/admin-permissions';
import { ROOT_ONLY_ROUTES } from '../src/modules/auth/route-permission-map';
import {
  createAdminWithPermissions,
  createCategory,
  createTestApp,
  createUser,
  providerPayload,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * PR-0 — what the guards actually do, over real HTTP.
 *
 * The map spec proves the decorators say the right thing; this proves the
 * application behaves the way they say. Every case here is one of the
 * invariants the RG-7 decisions named (I-3 … I-8), plus the two that make the
 * model coherent at all: a staff account with no role reaches nothing, and a
 * SUPER_ADMIN with no role reaches everything.
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

/** `loginAs` already returns a full `name=value` header. */
const cookie = (header: string) => header;

describe('admin panel access', () => {
  it('lets a SUPER_ADMIN in with no role assignment at all', async () => {
    const superAdmin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const session = await loginAs(ctx.prisma, superAdmin.id);

    const response = await request(ctx.server)
      .get('/admin/me/permissions')
      .set('Cookie', cookie(session));

    expect(response.status).toBe(200);
    expect(response.body.isSuperAdmin).toBe(true);
    // Reported as the whole catalogue rather than as an empty list plus a flag,
    // so a client that reads only `permissions` is still right.
    expect(response.body.permissions).toHaveLength(ALL_ADMIN_PERMISSIONS.length);
  });

  it('refuses an ADMIN that holds no role (I-6 precondition)', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.ADMIN });
    const session = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server)
      .get('/admin/me/permissions')
      .set('Cookie', cookie(session));

    expect(response.status).toBe(403);
    // Not NOT_STAFF: this account *is* staff, and the panel must explain that
    // rather than send it back to a sign-in form it is already past.
    expect(response.body.code).toBe('ADMIN_ACCESS_DENIED');
  });

  it('tells a customer or a provider apart from a staff account, in the refusal', async () => {
    // The panel routes on this code: NOT_STAFF goes to the sign-in form — the
    // behaviour that existed before permissions did — and everything else goes
    // to the page that explains. Without the distinction a provider who opens
    // an admin URL would be told "you lack a permission", which is not what is
    // wrong with them.
    for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER] as const) {
      const user = await createUser(ctx.prisma, { role });
      const session = await loginAs(ctx.prisma, user.id);

      const viaAccessGuard = await request(ctx.server)
        .get('/admin/me/permissions')
        .set('Cookie', cookie(session));
      expect(viaAccessGuard.status).toBe(403);
      expect(viaAccessGuard.body.code).toBe('NOT_STAFF');

      const viaPermissionsGuard = await request(ctx.server)
        .get('/customers')
        .set('Cookie', cookie(session));
      expect(viaPermissionsGuard.status).toBe(403);
      expect(viaPermissionsGuard.body.code).toBe('NOT_STAFF');
    }
  });

  it('marks a staff account’s missing permission as its own refusal', async () => {
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.DASHBOARD_READ]);
    const session = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server).get('/customers').set('Cookie', cookie(session));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_PERMISSION');
    // The refusal never names what is missing: a 403 that lists the permission
    // it wanted is a map of the panel for anybody probing it.
    expect(JSON.stringify(response.body)).not.toContain('CUSTOMERS_READ');
  });

  it('refuses a customer and a provider even if an assignment somehow exists', async () => {
    const superAdmin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const role = await ctx.prisma.adminRole.create({
      data: {
        key: `role-${uniqueSuffix()}`,
        name: 'Rogue',
        createdById: superAdmin.id,
        permissions: { create: [{ permission: AdminPermission.DASHBOARD_READ }] },
      },
    });

    for (const accountRole of [UserRole.CUSTOMER, UserRole.PROVIDER] as const) {
      const user = await createUser(ctx.prisma, { role: accountRole });
      await ctx.prisma.adminRoleAssignment.create({
        data: { userId: user.id, roleId: role.id, assignedById: superAdmin.id },
      });
      const session = await loginAs(ctx.prisma, user.id);

      const response = await request(ctx.server)
        .get('/dashboard/admin-summary')
        .set('Cookie', cookie(session));

      // The account kind is checked as well as the permission list, so a row
      // that should not exist cannot become access.
      expect(response.status).toBe(403);
    }
  });

  it('lets an ADMIN through exactly where its permissions reach', async () => {
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.DASHBOARD_READ]);
    const session = await loginAs(ctx.prisma, admin.id);

    const allowed = await request(ctx.server)
      .get('/dashboard/admin-summary')
      .set('Cookie', cookie(session));
    expect(allowed.status).toBe(200);

    const refused = await request(ctx.server).get('/customers').set('Cookie', cookie(session));
    expect(refused.status).toBe(403);
  });

  it('stops counting a revoked assignment', async () => {
    const { admin, role } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.DASHBOARD_READ,
    ]);
    const session = await loginAs(ctx.prisma, admin.id);

    expect(
      (await request(ctx.server).get('/dashboard/admin-summary').set('Cookie', cookie(session)))
        .status,
    ).toBe(200);

    await ctx.prisma.adminRoleAssignment.updateMany({
      where: { userId: admin.id, roleId: role.id },
      data: { revokedAt: new Date(), revokedById: admin.id },
    });

    // No re-login: the permission read happens with the session on every
    // request, so a revocation takes effect on the operator's next click.
    expect(
      (await request(ctx.server).get('/dashboard/admin-summary').set('Cookie', cookie(session)))
        .status,
    ).toBe(403);
  });

  it('stops counting an inactive role, without touching a single assignment', async () => {
    const { admin, role } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.DASHBOARD_READ,
    ]);
    const session = await loginAs(ctx.prisma, admin.id);

    await ctx.prisma.adminRole.update({ where: { id: role.id }, data: { isActive: false } });

    expect(
      (await request(ctx.server).get('/dashboard/admin-summary').set('Cookie', cookie(session)))
        .status,
    ).toBe(403);

    const assignments = await ctx.prisma.adminRoleAssignment.count({
      where: { userId: admin.id, revokedAt: null },
    });
    // Deactivating a role takes the capability from everyone at once and leaves
    // the assignments intact, so reactivating it gives them back.
    expect(assignments).toBe(1);
  });

  it('answers /admin/me/permissions with exactly what the guards enforce', async () => {
    const granted = [AdminPermission.DASHBOARD_READ, AdminPermission.CUSTOMERS_READ];
    const { admin } = await createAdminWithPermissions(ctx.prisma, granted);
    const session = await loginAs(ctx.prisma, admin.id);

    const described = await request(ctx.server)
      .get('/admin/me/permissions')
      .set('Cookie', cookie(session));

    expect(described.status).toBe(200);
    expect(described.body.isSuperAdmin).toBe(false);
    expect(described.body.permissions).toEqual([...granted].sort());

    // The same two, asked of the routes that need them.
    expect((await request(ctx.server).get('/customers').set('Cookie', cookie(session))).status).toBe(200);
    expect((await request(ctx.server).get('/offers').set('Cookie', cookie(session))).status).toBe(403);
  });
});

describe('root capabilities are not delegable (RG-7 §12.1)', () => {
  it('refuses an ADMIN holding the entire catalogue on every root route (I-6)', async () => {
    const { admin } = await createAdminWithPermissions(ctx.prisma, [...ALL_ADMIN_PERMISSIONS]);
    const session = await loginAs(ctx.prisma, admin.id);

    for (const route of ROOT_ONLY_ROUTES) {
      const path = route.path.replace(':id', 'x').replace(':userId', 'x').replace(':roleId', 'y');
      const response = await request(ctx.server)
        [route.method.toLowerCase() as 'get'](path)
        .set('Cookie', cookie(session))
        .send({});

      expect(response.status, `${route.method} ${path}`).toBe(403);
    }
  });

  it('creates a staff account as ADMIN, never as SUPER_ADMIN (I-3)', async () => {
    const superAdmin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const session = await loginAs(ctx.prisma, superAdmin.id);
    const suffix = uniqueSuffix();

    const response = await request(ctx.server)
      .post('/users')
      .set('Cookie', cookie(session))
      .send({ name: `Yeni Yönetici ${suffix}`, email: `staff-${suffix}@example.test` });

    expect(response.status).toBe(201);

    const created = await ctx.prisma.user.findUnique({
      where: { id: response.body.user?.id ?? response.body.id },
      select: { role: true, passwordHash: true },
    });
    expect(created?.role).toBe(UserRole.ADMIN);
    // Born without a password: the invite is what sets one.
    expect(created?.passwordHash).toBeNull();
  });

  it('leaves the role alone when an invite is accepted (I-4)', async () => {
    const superAdmin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const session = await loginAs(ctx.prisma, superAdmin.id);
    const suffix = uniqueSuffix();

    const created = await request(ctx.server)
      .post('/users')
      .set('Cookie', cookie(session))
      .send({ name: `Davetli ${suffix}`, email: `invited-${suffix}@example.test` });
    const userId: string = created.body.user?.id ?? created.body.id;

    const invite = await request(ctx.server)
      .post(`/users/${userId}/invite-link`)
      .set('Cookie', cookie(session))
      .send({});
    expect(invite.status).toBe(201);

    const token = String(invite.body.inviteUrl ?? invite.body.url ?? '').split('token=')[1];
    expect(token, 'davet bağlantısında token yok').toBeTruthy();

    const accepted = await request(ctx.server)
      .post('/auth/admin-invite')
      .send({ token, password: 'Password123!' });
    expect(accepted.status).toBeLessThan(400);

    const after = await ctx.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, passwordHash: true },
    });
    // Proving control of a mailbox sets a password. It is not a promotion.
    expect(after?.role).toBe(UserRole.ADMIN);
    expect(after?.passwordHash).toBeTruthy();
  });

  it('has no route that writes SUPER_ADMIN onto an account (I-5)', async () => {
    const superAdmin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const session = await loginAs(ctx.prisma, superAdmin.id);
    const { admin } = await createAdminWithPermissions(ctx.prisma, []);

    // The create route ignores a role in the body — `forbidNonWhitelisted`
    // refuses it outright — and there is no update route that takes one.
    const attempt = await request(ctx.server)
      .post('/users')
      .set('Cookie', cookie(session))
      .send({
        name: 'Terfi denemesi',
        email: `promote-${uniqueSuffix()}@example.test`,
        role: 'SUPER_ADMIN',
      });
    expect(attempt.status).toBe(400);

    const unchanged = await ctx.prisma.user.findUnique({
      where: { id: admin.id },
      select: { role: true },
    });
    expect(unchanged?.role).toBe(UserRole.ADMIN);
  });
});

describe('the campaign engine switch is its own permission (I-8, RG-7 §12.4)', () => {
  it('refuses a role that may write every other operations setting', async () => {
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.OPERATIONS_SETTINGS_READ,
      AdminPermission.OPERATIONS_SETTINGS_WRITE,
      AdminPermission.SCHEDULERS_WRITE,
      AdminPermission.MARKETPLACE_PUBLISH_WRITE,
      AdminPermission.PROVIDER_REVIEWS_SETTING_WRITE,
    ]);
    const session = await loginAs(ctx.prisma, admin.id);

    // It may read the switch…
    expect(
      (
        await request(ctx.server)
          .get('/operations-settings/campaign-engine')
          .set('Cookie', cookie(session))
      ).status,
    ).toBe(200);

    // …and may not move it.
    const attempt = await request(ctx.server)
      .put('/operations-settings/campaign-engine')
      .set('Cookie', cookie(session))
      .send({ enabled: true });
    expect(attempt.status).toBe(403);

    const settings = await ctx.prisma.operationsSettings.findFirst({
      select: { campaignEngineEnabled: true },
    });
    // Default-off is not disturbed by a refused attempt.
    expect(settings?.campaignEngineEnabled ?? false).toBe(false);
  });
});

describe('provider-scoped routes stay outside the permission model (I-7, RG-7 §12.2)', () => {
  /**
   * The 21 routes guarded only by `ProviderAccessGuard`. They are reachable by
   * the provider who owns the record and by a SUPER_ADMIN, and by nobody else —
   * no ADMIN role opens them, however many permissions it holds. Mock payment
   * and "offer on a provider's behalf" are the two that make this matter.
   */
  const PROVIDER_SCOPED: { method: 'get' | 'post' | 'patch'; path: string }[] = [
    { method: 'get', path: '/providers/PID/credits' },
    { method: 'get', path: '/providers/PID/credits/transactions' },
    { method: 'get', path: '/providers/PID/entitlements' },
    { method: 'get', path: '/providers/PID/offer-packages' },
    { method: 'post', path: '/providers/PID/package-purchases' },
    { method: 'get', path: '/providers/PID/package-purchases' },
    { method: 'post', path: '/providers/PID/package-purchases/x/mock-pay' },
    { method: 'post', path: '/providers/PID/checkout-sessions' },
    { method: 'get', path: '/providers/PID/reviews' },
    { method: 'get', path: '/providers/PID/reviews/summary' },
    { method: 'get', path: '/providers/PID/requests' },
    { method: 'get', path: '/providers/PID/offers' },
    { method: 'post', path: '/providers/PID/requests/x/offers' },
  ];

  it('refuses an ADMIN holding every permission', async () => {
    const { admin } = await createAdminWithPermissions(ctx.prisma, [...ALL_ADMIN_PERMISSIONS]);
    const session = await loginAs(ctx.prisma, admin.id);
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await ctx.prisma.providerProfile.create({
      data: {
        userId: owner.id,
        businessName: `İşletme ${uniqueSuffix()}`,
        contactName: 'Ad Soyad',
        phone: `+9055500${uniqueSuffix().padStart(5, '0')}`,
        city: 'İstanbul',
        district: 'Kadıköy',
      },
      select: { id: true },
    });

    for (const route of PROVIDER_SCOPED) {
      const path = route.path.replace('PID', provider.id);
      const response = await request(ctx.server)
        [route.method](path)
        .set('Cookie', cookie(session))
        .send({});

      expect(response.status, `${route.method.toUpperCase()} ${path}`).toBe(403);
    }
  });
});

describe('PATCH /providers/:id asks the permission of staff only (RG-7 §12.3)', () => {
  /**
   * A real application, created through the public route, so the PATCH below
   * sends the shape that route produced. `UpdateProviderDto` extends the create
   * DTO — a save replaces the profile — so a partial body is a 400 rather than
   * a partial update, and a test that sent one would be asserting on
   * validation instead of on authorization.
   */
  async function makeProvider() {
    const category = await createCategory(ctx.prisma);
    const payload = providerPayload([category.id]);
    const created = await request(ctx.server).post('/providers').send(payload).expect(201);
    const owner = await ctx.prisma.user.create({
      data: {
        email: `owner-${uniqueSuffix()}@example.test`,
        role: UserRole.PROVIDER,
        isActive: true,
      },
      select: { id: true },
    });
    await ctx.prisma.providerProfile.update({
      where: { id: created.body.id },
      data: { userId: owner.id },
    });
    return { owner, provider: { id: created.body.id as string }, payload };
  }

  it('leaves the owner’s own path exactly as it was', async () => {
    const { owner, provider, payload } = await makeProvider();
    const session = await loginAs(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie(session))
      .send({ ...payload, contactName: 'Yeni Ad' });

    // The provider holds no permission at all; the service's ownership rules
    // are what decide here, exactly as before PR-0.
    expect(response.status).toBeLessThan(400);
  });

  it('refuses a staff account without PROVIDERS_WRITE', async () => {
    const { provider, payload } = await makeProvider();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.PROVIDERS_READ,
      AdminPermission.PROVIDERS_READ_DETAIL,
    ]);
    const session = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie(session))
      .send({ ...payload, contactName: 'Operatör düzeltmesi' });

    expect(response.status).toBe(403);
  });

  it('admits a staff account that holds it', async () => {
    const { provider, payload } = await makeProvider();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.PROVIDERS_WRITE]);
    const session = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie(session))
      .send({ ...payload, contactName: 'Operatör düzeltmesi' });

    expect(response.status).toBeLessThan(400);
  });
});
