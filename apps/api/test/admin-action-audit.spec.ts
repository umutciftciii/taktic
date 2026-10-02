import {
  AdminPermission,
  OfferPackageType,
  ProviderStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createCategory,
  createOfferPackage,
  createProviderProfile,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * ADMIN-ACTION-AUDIT-001 — the admin action audit, domain by domain.
 *
 * For every write path: a real change writes exactly one immutable row with
 * the operator and the stored before/after values; a save that changes nothing
 * writes none; a refused write writes none. For every read path: the domain's
 * own read permission opens it, the actor's e-mail follows `staffActorSelect`,
 * and paging is stable.
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

async function staff(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function superAdmin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name: 'Kök Yönetici' });
  return { user, cookie: await loginAs(ctx.prisma, user.id) };
}

describe('A — role audit read', () => {
  it('pages the rows the role writes have always produced, root-only', async () => {
    const root = await superAdmin();
    const created = await request(ctx.server)
      .post('/admin/roles')
      .set('Cookie', root.cookie)
      .send({ key: 'destek-ekibi', name: 'Destek ekibi', permissions: [AdminPermission.SUPPORT_READ] })
      .expect(201);
    const roleId: string = created.body.id;

    await request(ctx.server)
      .put(`/admin/roles/${roleId}/permissions`)
      .set('Cookie', root.cookie)
      .send({ permissions: [AdminPermission.SUPPORT_READ, AdminPermission.CUSTOMERS_READ] })
      .expect(200);

    const target = await createUser(ctx.prisma, { role: UserRole.ADMIN, name: 'Ayşe Personel' });
    await request(ctx.server)
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', root.cookie)
      .send({ roleId })
      .expect(201);

    const page = await request(ctx.server).get(`/admin/roles/${roleId}/audit`).set('Cookie', root.cookie).expect(200);
    expect(page.body.total).toBe(3);
    expect(page.body.items.map((item: { action: string }) => item.action)).toEqual([
      'ASSIGNMENT_GRANTED',
      'ROLE_PERMISSIONS_REPLACED',
      'ROLE_CREATED',
    ]);
    const [granted, replaced, born] = page.body.items;
    expect(granted.actor).toEqual({ id: root.user.id, name: 'Kök Yönetici', email: root.user.email });
    expect(granted.targetUser).toMatchObject({ id: target.id, name: 'Ayşe Personel' });
    expect(granted.target).toEqual({ type: 'ADMIN_ROLE', id: roleId, label: 'Destek ekibi' });
    expect(replaced.payload).toEqual({
      key: 'destek-ekibi',
      added: [AdminPermission.CUSTOMERS_READ],
      removed: [],
      total: 2,
    });
    expect(born.payload).toMatchObject({ key: 'destek-ekibi', name: 'Destek ekibi' });

    const second = await request(ctx.server)
      .get(`/admin/roles/${roleId}/audit?page=2&pageSize=2`)
      .set('Cookie', root.cookie)
      .expect(200);
    expect(second.body).toMatchObject({ total: 3, page: 2, pageSize: 2, hasNextPage: false });
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([born.id]);

    const forUser = await request(ctx.server)
      .get(`/admin/users/${target.id}/role-audit`)
      .set('Cookie', root.cookie)
      .expect(200);
    expect(forUser.body.items.map((item: { action: string }) => item.action)).toEqual(['ASSIGNMENT_GRANTED']);

    await request(ctx.server).get('/admin/roles/nope/audit').set('Cookie', root.cookie).expect(404);
    await request(ctx.server)
      .get(`/admin/roles/${roleId}/audit?pageSize=500`)
      .set('Cookie', root.cookie)
      .expect(400);

    // An ADMIN holding every delegable permission is still refused.
    const delegated = await staff(Object.values(AdminPermission));
    await request(ctx.server).get(`/admin/roles/${roleId}/audit`).set('Cookie', delegated.cookie).expect(403);
  });
});

describe('B — staff account status audit', () => {
  it('records a real flip with actor and values; a no-op and a refused write record nothing', async () => {
    const operator = await staff([AdminPermission.ADMIN_USERS_STATUS, AdminPermission.ADMIN_USERS_READ]);
    const target = await createUser(ctx.prisma, { role: UserRole.ADMIN });

    await request(ctx.server)
      .patch(`/users/${target.id}/status`)
      .set('Cookie', operator.cookie)
      .send({ isActive: false })
      .expect(200);
    // The same value again: 200, as before, and no second row.
    await request(ctx.server)
      .patch(`/users/${target.id}/status`)
      .set('Cookie', operator.cookie)
      .send({ isActive: false })
      .expect(200);
    // Self-deactivation stays refused, and leaves no row.
    await request(ctx.server)
      .patch(`/users/${operator.admin.id}/status`)
      .set('Cookie', operator.cookie)
      .send({ isActive: false })
      .expect(409);

    const rows = await ctx.prisma.accountStatusChange.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: target.id,
      userRole: UserRole.ADMIN,
      fromActive: true,
      toActive: false,
      reason: null,
      actorId: operator.admin.id,
    });

    const history = await request(ctx.server)
      .get(`/users/${target.id}/status-history`)
      .set('Cookie', operator.cookie)
      .expect(200);
    expect(history.body).toMatchObject({ total: 1, page: 1, hasNextPage: false });
    expect(history.body.items[0]).toMatchObject({
      domain: 'STAFF_ACCOUNT',
      action: 'DEACTIVATED',
      changes: [{ field: 'isActive', from: true, to: false }],
      reason: null,
      actor: { id: operator.admin.id, email: operator.admin.email },
    });
  });

  it('keeps the super admin guards and audits nothing they refuse', async () => {
    const delegated = await staff([AdminPermission.ADMIN_USERS_STATUS]);
    const lastRoot = await superAdmin();

    await request(ctx.server)
      .patch(`/users/${lastRoot.user.id}/status`)
      .set('Cookie', delegated.cookie)
      .send({ isActive: false })
      .expect(403);
    await request(ctx.server)
      .patch(`/users/${lastRoot.user.id}/status`)
      .set('Cookie', lastRoot.cookie)
      .send({ isActive: false })
      .expect(409);
    expect(await ctx.prisma.accountStatusChange.count()).toBe(0);
  });

  it('reads with ADMIN_USERS_READ only, and only for staff accounts', async () => {
    const reader = await staff([AdminPermission.ADMIN_USERS_READ]);
    const outsider = await staff([AdminPermission.CUSTOMERS_READ]);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    await request(ctx.server).get(`/users/${reader.admin.id}/status-history`).set('Cookie', outsider.cookie).expect(403);
    await request(ctx.server).get(`/users/${customer.id}/status-history`).set('Cookie', reader.cookie).expect(404);
  });
});

describe('C — customer status audit', () => {
  it('records each real flip; the actor e-mail follows ADMIN_USERS_READ', async () => {
    const operator = await staff([AdminPermission.CUSTOMERS_STATUS, AdminPermission.CUSTOMERS_READ]);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    for (const isActive of [false, false, true]) {
      await request(ctx.server)
        .patch(`/customers/${customer.id}/status`)
        .set('Cookie', operator.cookie)
        .send({ isActive })
        .expect(200);
    }

    const rows = await ctx.prisma.accountStatusChange.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(rows.map((row) => [row.fromActive, row.toActive, row.userRole])).toEqual([
      [true, false, UserRole.CUSTOMER],
      [false, true, UserRole.CUSTOMER],
    ]);

    const withoutStaffDirectory = await request(ctx.server)
      .get(`/customers/${customer.id}/status-history`)
      .set('Cookie', operator.cookie)
      .expect(200);
    expect(withoutStaffDirectory.body.total).toBe(2);
    expect(withoutStaffDirectory.body.items[0].action).toBe('ACTIVATED');
    expect(Object.keys(withoutStaffDirectory.body.items[0].actor).sort()).toEqual(['id', 'name']);

    const directory = await staff([AdminPermission.CUSTOMERS_READ, AdminPermission.ADMIN_USERS_READ]);
    const withDirectory = await request(ctx.server)
      .get(`/customers/${customer.id}/status-history`)
      .set('Cookie', directory.cookie)
      .expect(200);
    expect(withDirectory.body.items[0].actor.email).toBe(operator.admin.email);

    const noRead = await staff([AdminPermission.CUSTOMERS_STATUS]);
    await request(ctx.server).get(`/customers/${customer.id}/status-history`).set('Cookie', noRead.cookie).expect(403);
  });

  it('rows are append-only', async () => {
    const operator = await staff([AdminPermission.CUSTOMERS_STATUS]);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await request(ctx.server)
      .patch(`/customers/${customer.id}/status`)
      .set('Cookie', operator.cookie)
      .send({ isActive: false })
      .expect(200);
    const row = await ctx.prisma.accountStatusChange.findFirstOrThrow();

    await expect(
      ctx.prisma.accountStatusChange.update({ where: { id: row.id }, data: { reason: 'sonradan' } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.accountStatusChange.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});

describe('D — provider status audit', () => {
  it('records real transitions with the reason written; a same-status save records none', async () => {
    const operator = await staff([AdminPermission.PROVIDERS_MODERATE, AdminPermission.PROVIDERS_READ_DETAIL]);
    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    const patch = (body: Record<string, unknown>) =>
      request(ctx.server).patch(`/providers/${provider.id}/status`).set('Cookie', operator.cookie).send(body);

    await patch({ status: ProviderStatus.APPROVED }).expect(200);
    await patch({ status: ProviderStatus.APPROVED, moderationNote: 'Belge yenilendi' }).expect(200);
    await patch({ status: ProviderStatus.REJECTED }).expect(400);
    await patch({
      status: ProviderStatus.REJECTED,
      rejectionReason: 'Vergi levhası eksik',
      moderationNote: 'Telefonla arandı',
    }).expect(200);

    const history = await request(ctx.server)
      .get(`/providers/${provider.id}/status-history`)
      .set('Cookie', operator.cookie)
      .expect(200);
    expect(history.body.total).toBe(2);
    const [rejected, approved] = history.body.items;
    expect(rejected).toMatchObject({
      domain: 'PROVIDER',
      changes: [{ field: 'status', from: 'APPROVED', to: 'REJECTED' }],
      reason: 'Vergi levhası eksik',
      note: 'Telefonla arandı',
      actor: { id: operator.admin.id },
    });
    expect(Object.keys(rejected.actor).sort()).toEqual(['id', 'name']);
    expect(approved).toMatchObject({
      changes: [{ field: 'status', from: 'PENDING_REVIEW', to: 'APPROVED' }],
      reason: null,
      note: null,
    });

    const listOnly = await staff([AdminPermission.PROVIDERS_READ]);
    await request(ctx.server).get(`/providers/${provider.id}/status-history`).set('Cookie', listOnly.cookie).expect(403);
  });
});

describe('E — company settings field audit', () => {
  const body = { legalName: 'Taktik Teknoloji A.Ş.', supportEmail: 'destek@taktik.com.tr' };

  it('records only the changed fields, and nothing for a no-op save', async () => {
    const writer = await staff([AdminPermission.COMPANY_SETTINGS_WRITE, AdminPermission.COMPANY_SETTINGS_READ]);
    const put = (payload: Record<string, unknown>) =>
      request(ctx.server).put('/company-settings').set('Cookie', writer.cookie).send(payload).expect(200);

    await put(body);
    await put(body);
    await put({ ...body, postalAddress: 'Kadıköy, İstanbul' });

    const settings = await ctx.prisma.companySettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(settings.updatedById).toBe(writer.admin.id);

    const history = await request(ctx.server).get('/company-settings/history').set('Cookie', writer.cookie).expect(200);
    expect(history.body.total).toBe(2);
    expect(history.body.items[0].changes).toEqual([{ field: 'postalAddress', from: null, to: 'Kadıköy, İstanbul' }]);
    expect(history.body.items[1].changes).toEqual([
      { field: 'legalName', from: null, to: body.legalName },
      { field: 'supportEmail', from: null, to: body.supportEmail },
    ]);
    expect(history.body.items[1].actor.id).toBe(writer.admin.id);

    const reader = await staff([AdminPermission.COMPANY_SETTINGS_READ]);
    await request(ctx.server).get('/company-settings/history').set('Cookie', reader.cookie).expect(200);
    const outsider = await staff([AdminPermission.CUSTOMERS_READ]);
    await request(ctx.server).get('/company-settings/history').set('Cookie', outsider.cookie).expect(403);
  });
});

describe('F — catalogue audit', () => {
  it('category: create, edit, status and echo, with a parent reference snapshot', async () => {
    const operator = await staff([
      AdminPermission.CATEGORIES_WRITE,
      AdminPermission.CATEGORIES_STATUS,
      AdminPermission.CATALOG_READ,
    ]);
    const group = await createCategory(ctx.prisma, 'Ev Hizmetleri', { kind: ServiceCategoryKind.GROUP });

    const created = await request(ctx.server)
      .post('/categories')
      .set('Cookie', operator.cookie)
      .send({
        name: 'Boya Badana',
        slug: 'boya-badana',
        status: ServiceCategoryStatus.DRAFT,
        parentId: group.id,
        offerCreditCost: 3,
      })
      .expect(201);
    const id: string = created.body.id;

    await request(ctx.server)
      .patch(`/categories/${id}`)
      .set('Cookie', operator.cookie)
      .send({ name: 'Boya ve Badana', offerCreditCost: 4 })
      .expect(200);
    // An echo of the stored values.
    await request(ctx.server)
      .patch(`/categories/${id}`)
      .set('Cookie', operator.cookie)
      .send({ name: 'Boya ve Badana', offerCreditCost: 4, status: ServiceCategoryStatus.DRAFT })
      .expect(200);
    await request(ctx.server)
      .patch(`/categories/${id}/status`)
      .set('Cookie', operator.cookie)
      .send({ status: ServiceCategoryStatus.INACTIVE })
      .expect(200);

    const history = await request(ctx.server)
      .get('/admin/categories/boya-badana/history')
      .set('Cookie', operator.cookie)
      .expect(200);
    expect(history.body.items.map((item: { action: string }) => item.action)).toEqual([
      'STATUS_CHANGED',
      'UPDATED',
      'CREATED',
    ]);
    const [status, edit, born] = history.body.items;
    expect(status.changes).toEqual([{ field: 'status', from: 'DRAFT', to: 'INACTIVE' }]);
    expect(edit.changes).toEqual([
      { field: 'name', from: 'Boya Badana', to: 'Boya ve Badana' },
      { field: 'offerCreditCost', from: 3, to: 4 },
    ]);
    expect(born.changes).toEqual(
      expect.arrayContaining([
        { field: 'name', from: null, to: 'Boya Badana' },
        { field: 'parent', from: null, to: { id: group.id, name: group.name } },
        { field: 'status', from: null, to: 'DRAFT' },
      ]),
    );
    expect(born.actor.id).toBe(operator.admin.id);

    // A refused status change writes nothing.
    const writeOnly = await staff([AdminPermission.CATEGORIES_WRITE]);
    await request(ctx.server)
      .patch(`/categories/${id}`)
      .set('Cookie', writeOnly.cookie)
      .send({ status: ServiceCategoryStatus.ACTIVE })
      .expect(403);
    expect(await ctx.prisma.catalogAuditLog.count()).toBe(3);

    const outsider = await staff([AdminPermission.CUSTOMERS_READ]);
    await request(ctx.server).get('/admin/categories/boya-badana/history').set('Cookie', outsider.cookie).expect(403);
  });

  it('category history survives the category being deleted', async () => {
    const operator = await staff([
      AdminPermission.CATEGORIES_WRITE,
      AdminPermission.CATEGORIES_DELETE,
      AdminPermission.CATALOG_READ,
    ]);
    const created = await request(ctx.server)
      .post('/categories')
      .set('Cookie', operator.cookie)
      .send({ name: 'Geçici', slug: 'gecici', status: ServiceCategoryStatus.DRAFT, offerCreditCost: 2 })
      .expect(201);
    await request(ctx.server).delete(`/categories/${created.body.id}`).set('Cookie', operator.cookie).expect(200);
    expect(await ctx.prisma.catalogAuditLog.count({ where: { entityId: created.body.id } })).toBe(1);
  });

  it('credit package: create, scope edit and status switch, as readable diffs', async () => {
    const operator = await staff([
      AdminPermission.CREDIT_PACKAGES_WRITE,
      AdminPermission.CREDIT_PACKAGES_STATUS,
      AdminPermission.CREDIT_PACKAGES_READ,
    ]);
    const klima = await createCategory(ctx.prisma, 'Klima', { unlimitedPackageEligible: true });
    const kombi = await createCategory(ctx.prisma, 'Kombi', { unlimitedPackageEligible: true });

    const created = await request(ctx.server)
      .post('/credit-packages')
      .set('Cookie', operator.cookie)
      .send({
        name: 'Sınırsız Isıtma',
        slug: 'sinirsiz-isitma',
        type: OfferPackageType.CATEGORY_UNLIMITED,
        priceAmount: 99_900,
        scopeCategoryIds: [klima.id],
      })
      .expect(201);
    const id: string = created.body.id;

    await request(ctx.server)
      .patch(`/credit-packages/${id}`)
      .set('Cookie', operator.cookie)
      .send({ priceAmount: 119_900, scopeCategoryIds: [klima.id, kombi.id] })
      .expect(200);
    await request(ctx.server)
      .patch(`/credit-packages/${id}/status`)
      .set('Cookie', operator.cookie)
      .send({ isActive: false })
      .expect(200);
    await request(ctx.server)
      .patch(`/credit-packages/${id}/status`)
      .set('Cookie', operator.cookie)
      .send({ isActive: false })
      .expect(200);

    const history = await request(ctx.server)
      .get(`/admin/offer-packages/${id}/history`)
      .set('Cookie', operator.cookie)
      .expect(200);
    expect(history.body.items.map((item: { action: string }) => item.action)).toEqual([
      'STATUS_CHANGED',
      'UPDATED',
      'CREATED',
    ]);
    expect(history.body.items[0].changes).toEqual([{ field: 'isActive', from: true, to: false }]);
    const sortById = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect(history.body.items[1].changes).toEqual([
      { field: 'priceAmount', from: 99_900, to: 119_900 },
      {
        field: 'scopeCategories',
        from: [{ id: klima.id, name: klima.name }],
        to: sortById([
          { id: klima.id, name: klima.name },
          { id: kombi.id, name: kombi.name },
        ]),
      },
    ]);

    const unknown = await request(ctx.server)
      .get('/admin/offer-packages/nope/history')
      .set('Cookie', operator.cookie);
    expect(unknown.status).toBe(404);
  });

  it('credit package: a pre-existing package has no invented history', async () => {
    const reader = await staff([AdminPermission.CREDIT_PACKAGES_READ]);
    const pkg = await createOfferPackage(ctx.prisma);
    const history = await request(ctx.server)
      .get(`/admin/offer-packages/${pkg.id}/history`)
      .set('Cookie', reader.cookie)
      .expect(200);
    expect(history.body).toMatchObject({ items: [], total: 0 });
  });

  it('showcase package: create and edit; the edit permission alone cannot read', async () => {
    const operator = await staff([AdminPermission.SHOWCASE_PACKAGES_WRITE, AdminPermission.SHOWCASE_PACKAGES_READ]);
    const created = await request(ctx.server)
      .post('/admin/showcase/packages')
      .set('Cookie', operator.cookie)
      .send({ name: 'Vitrin 30', slug: 'vitrin-30-audit', priceAmount: 49_900, durationDays: 30 })
      .expect(201);
    const id: string = created.body.id;

    await request(ctx.server)
      .patch(`/admin/showcase/packages/${id}`)
      .set('Cookie', operator.cookie)
      .send({ durationDays: 45, maxAreas: 3 })
      .expect(200);
    await request(ctx.server)
      .patch(`/admin/showcase/packages/${id}`)
      .set('Cookie', operator.cookie)
      .send({ durationDays: 45 })
      .expect(200);
    await request(ctx.server)
      .patch(`/admin/showcase/packages/${id}`)
      .set('Cookie', operator.cookie)
      .send({ isActive: false })
      .expect(200);

    const history = await request(ctx.server)
      .get(`/admin/showcase/packages/${id}/history`)
      .set('Cookie', operator.cookie)
      .expect(200);
    expect(history.body.items.map((item: { action: string }) => item.action)).toEqual([
      'STATUS_CHANGED',
      'UPDATED',
      'CREATED',
    ]);
    expect(history.body.items[1].changes).toEqual([
      { field: 'durationDays', from: 30, to: 45 },
      { field: 'maxAreas', from: null, to: 3 },
    ]);

    const legacy = await createShowcasePackage(ctx.prisma);
    const empty = await request(ctx.server)
      .get(`/admin/showcase/packages/${legacy.id}/history`)
      .set('Cookie', operator.cookie)
      .expect(200);
    expect(empty.body.total).toBe(0);

    const writeOnly = await staff([AdminPermission.SHOWCASE_PACKAGES_WRITE]);
    await request(ctx.server).get(`/admin/showcase/packages/${id}/history`).set('Cookie', writeOnly.cookie).expect(403);
  });
});

describe('G — provider invite revoke actor', () => {
  it('stores who withdrew a link; a link withdrawn before the column says nobody', async () => {
    const root = await superAdmin();
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });
    const issue = () =>
      request(ctx.server).post(`/categories/${draft.id}/provider-invites`).set('Cookie', root.cookie).send({}).expect(201);
    const first = await issue();
    const legacy = await issue();

    const revoked = await request(ctx.server)
      .post(`/categories/${draft.id}/provider-invites/${first.body.id}/revoke`)
      .set('Cookie', root.cookie)
      .send({})
      .expect(200);
    expect(revoked.body.invite.revokedBy).toEqual({ id: root.user.id, name: 'Kök Yönetici' });

    // The shape of a link withdrawn before ADMIN-ACTION-AUDIT-001: an instant, no actor.
    await ctx.prisma.providerInviteToken.update({ where: { id: legacy.body.id }, data: { revokedAt: new Date() } });

    const list = await request(ctx.server)
      .get(`/categories/${draft.id}/provider-invites`)
      .set('Cookie', root.cookie)
      .expect(200);
    const byId = new Map(list.body.invites.map((invite: { id: string }) => [invite.id, invite]));
    expect(byId.get(first.body.id)).toMatchObject({ state: 'REVOKED', revokedBy: { id: root.user.id } });
    expect(byId.get(legacy.body.id)).toMatchObject({ state: 'REVOKED', revokedBy: null });

    // The database refuses an actor on a link that is not withdrawn.
    const live = await issue();
    await expect(
      ctx.prisma.providerInviteToken.update({ where: { id: live.body.id }, data: { revokedById: root.user.id } }),
    ).rejects.toThrow(/ProviderInviteToken_revoker_requires_revoked/);
  });
});
