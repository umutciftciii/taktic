import { AdminPermission, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UsersService } from '../src/modules/users/users.service';
import {
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
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — the server half of Faz 1.
 *
 * A confirmation dialog is not a security boundary; these are the rules the
 * API holds whatever the panel draws:
 *
 * - a SUPER_ADMIN account's status is a SUPER_ADMIN's to change, in both
 *   directions, even for an ADMIN holding ADMIN_USERS_STATUS;
 * - creating a credit package already on sale, or a category already out of
 *   DRAFT, needs the STATUS permission as well as WRITE — the create route can
 *   no longer be used to skip the status split the edit routes enforce;
 * - a placement cancellation carries a reason.
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
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { user, cookie: await loginAs(ctx.prisma, user.id) };
}

describe('PATCH /users/:id/status on a SUPER_ADMIN target', () => {
  function setStatus(id: string, cookie: string, isActive: boolean) {
    return request(ctx.server).patch(`/users/${id}/status`).set('Cookie', cookie).send({ isActive });
  }

  async function isActive(id: string) {
    return (await ctx.prisma.user.findUniqueOrThrow({ where: { id }, select: { isActive: true } })).isActive;
  }

  it('an ADMIN with ADMIN_USERS_STATUS still switches an ADMIN off and on', async () => {
    const { cookie } = await staff([AdminPermission.ADMIN_USERS_STATUS]);
    const target = await createUser(ctx.prisma, { role: UserRole.ADMIN });

    expect((await setStatus(target.id, cookie, false)).status).toBe(200);
    expect(await isActive(target.id)).toBe(false);
    expect((await setStatus(target.id, cookie, true)).status).toBe(200);
    expect(await isActive(target.id)).toBe(true);
  });

  it('the same ADMIN cannot deactivate a SUPER_ADMIN, even one that is not the last', async () => {
    const { cookie } = await staff([AdminPermission.ADMIN_USERS_STATUS]);
    // createAdminWithPermissions made one active super admin already; this is a second.
    const target = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const response = await setStatus(target.id, cookie, false);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SUPER_ADMIN_TARGET_REQUIRES_SUPER_ADMIN');
    expect(await isActive(target.id)).toBe(true);
  });

  it('the same ADMIN cannot reactivate a deactivated SUPER_ADMIN (the escalation path)', async () => {
    const { cookie } = await staff([AdminPermission.ADMIN_USERS_STATUS]);
    const target = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, isActive: false });

    const response = await setStatus(target.id, cookie, true);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SUPER_ADMIN_TARGET_REQUIRES_SUPER_ADMIN');
    expect(await isActive(target.id)).toBe(false);
  });

  it('is refused whatever the target state, so a no-op request reveals nothing either', async () => {
    const { cookie } = await staff([AdminPermission.ADMIN_USERS_STATUS]);
    const target = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const response = await setStatus(target.id, cookie, true);

    expect(response.status).toBe(403);
  });

  it('an ADMIN holding every permission is still refused', async () => {
    const { cookie } = await staff(Object.values(AdminPermission));
    const target = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, isActive: false });

    expect((await setStatus(target.id, cookie, true)).status).toBe(403);
    expect(await isActive(target.id)).toBe(false);
  });

  it('a SUPER_ADMIN switches another SUPER_ADMIN off and back on', async () => {
    const { cookie } = await superAdmin();
    const target = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    expect((await setStatus(target.id, cookie, false)).status).toBe(200);
    expect(await isActive(target.id)).toBe(false);
    expect((await setStatus(target.id, cookie, true)).status).toBe(200);
    expect(await isActive(target.id)).toBe(true);
  });

  it('keeps the existing guards for a SUPER_ADMIN caller: not oneself, not the last active super admin', async () => {
    const { user, cookie } = await superAdmin();

    expect((await setStatus(user.id, cookie, false)).status).toBe(409);
    expect(await isActive(user.id)).toBe(true);

    /*
     * The last-active guard. A super admin caller is itself active, so another
     * active target always leaves one; the guard is reached through the
     * service directly, with the caller's own account counted out — the state
     * a stale session or a concurrent deactivation would produce.
     */
    const target = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await ctx.prisma.user.updateMany({
      where: { role: UserRole.SUPER_ADMIN, id: { not: target.id } },
      data: { isActive: false },
    });
    const service = ctx.app.get(UsersService);
    await expect(
      service.updateStatus(target.id, { isActive: false }, { ...user, role: UserRole.SUPER_ADMIN }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await isActive(target.id)).toBe(true);
  });
});

describe('POST /credit-packages and the status permission', () => {
  const WRITE = AdminPermission.CREDIT_PACKAGES_WRITE;
  const STATUS = AdminPermission.CREDIT_PACKAGES_STATUS;
  let sequence = 0;

  function body(extra: Record<string, unknown> = {}) {
    sequence += 1;
    return {
      name: `Paket ${sequence}`,
      slug: `paket-create-${sequence}-${Date.now()}`,
      creditAmount: 10,
      priceAmount: 10000,
      ...extra,
    };
  }

  function create(cookie: string, payload: Record<string, unknown>) {
    return request(ctx.server).post('/credit-packages').set('Cookie', cookie).send(payload);
  }

  it('WRITE alone creates an inactive package', async () => {
    const { cookie } = await staff([WRITE]);
    const response = await create(cookie, body({ isActive: false }));

    expect(response.status).toBe(201);
    expect(response.body.isActive).toBe(false);
  });

  it('WRITE alone cannot create an active package, explicitly or by the default, and nothing is written', async () => {
    const { cookie } = await staff([WRITE]);

    for (const payload of [body({ isActive: true }), body()]) {
      const response = await create(cookie, payload);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_PERMISSION');
      expect(await ctx.prisma.offerCreditPackage.count({ where: { slug: payload.slug } })).toBe(0);
    }
  });

  it('STATUS alone cannot create at all', async () => {
    const { cookie } = await staff([STATUS]);
    expect((await create(cookie, body({ isActive: false }))).status).toBe(403);
    expect((await create(cookie, body({ isActive: true }))).status).toBe(403);
    expect(await ctx.prisma.offerCreditPackage.count()).toBe(0);
  });

  it('WRITE + STATUS creates an active package, explicitly or by the default', async () => {
    const { cookie } = await staff([WRITE, STATUS]);

    const explicit = await create(cookie, body({ isActive: true }));
    expect(explicit.status).toBe(201);
    expect(explicit.body.isActive).toBe(true);

    const defaulted = await create(cookie, body());
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.isActive).toBe(true);
  });

  it('a SUPER_ADMIN creates active packages as before', async () => {
    const { cookie } = await superAdmin();
    const response = await create(cookie, body());
    expect(response.status).toBe(201);
    expect(response.body.isActive).toBe(true);
  });
});

describe('POST /categories and the status permission', () => {
  const WRITE = AdminPermission.CATEGORIES_WRITE;
  const STATUS = AdminPermission.CATEGORIES_STATUS;
  let sequence = 0;

  function body(extra: Record<string, unknown> = {}) {
    sequence += 1;
    return {
      name: `Kategori ${sequence}`,
      slug: `kategori-create-${sequence}-${Date.now()}`,
      offerCreditCost: 2,
      ...extra,
    };
  }

  function create(cookie: string, payload: Record<string, unknown>) {
    return request(ctx.server).post('/categories').set('Cookie', cookie).send(payload);
  }

  it('WRITE alone creates a DRAFT category', async () => {
    const { cookie } = await staff([WRITE]);
    const response = await create(cookie, body({ status: ServiceCategoryStatus.DRAFT }));

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('DRAFT');
    expect(response.body.isActive).toBe(false);
  });

  it('WRITE alone cannot create out of DRAFT — ACTIVE, INACTIVE, the legacy isActive or the ACTIVE default', async () => {
    const { cookie } = await staff([WRITE]);

    for (const payload of [
      body({ status: ServiceCategoryStatus.ACTIVE }),
      body({ status: ServiceCategoryStatus.INACTIVE }),
      body({ isActive: true }),
      body({ isActive: false }),
      body(),
    ]) {
      const response = await create(cookie, payload);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_PERMISSION');
      expect(await ctx.prisma.serviceCategory.count({ where: { slug: payload.slug } })).toBe(0);
    }
  });

  it('is refused before the parent is read, so the refusal does not depend on it', async () => {
    const { cookie } = await staff([WRITE]);
    const response = await create(cookie, body({ status: ServiceCategoryStatus.ACTIVE, parentId: 'missing' }));
    expect(response.status).toBe(403);
  });

  it('WRITE + STATUS creates in any status, and the default is still ACTIVE', async () => {
    const { cookie } = await staff([WRITE, STATUS]);

    for (const status of [ServiceCategoryStatus.ACTIVE, ServiceCategoryStatus.INACTIVE, ServiceCategoryStatus.DRAFT]) {
      const response = await create(cookie, body({ status }));
      expect(response.status).toBe(201);
      expect(response.body.status).toBe(status);
    }

    const defaulted = await create(cookie, body());
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.status).toBe('ACTIVE');
  });

  it('a SUPER_ADMIN creates as before, the ACTIVE default included', async () => {
    const { cookie } = await superAdmin();
    const response = await create(cookie, body());
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('ACTIVE');
  });

  it('the public catalogue still lists what a permitted create published', async () => {
    const { cookie } = await staff([WRITE, STATUS]);
    const created = await create(cookie, body({ status: ServiceCategoryStatus.ACTIVE }));
    const publicList = await request(ctx.server).get('/categories');
    expect(publicList.body.map((category: { id: string }) => category.id)).toContain(created.body.id);
  });
});

describe('POST /admin/showcase/placements/:id/cancel requires a reason', () => {
  async function livePlacement() {
    const category = await createCategory(ctx.prisma, 'Klima');
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const profile = await createDiscoverableProvider(ctx.prisma, {
      userId: providerUser.id,
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
    return placement;
  }

  function cancel(placementId: string, cookie: string, payload: Record<string, unknown>) {
    return request(ctx.server)
      .post(`/admin/showcase/placements/${placementId}/cancel`)
      .set('Cookie', cookie)
      .send(payload);
  }

  it('refuses a missing, blank or too-short note and changes nothing', async () => {
    const placement = await livePlacement();
    const { cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);

    for (const payload of [{}, { note: null }, { note: '' }, { note: '          ' }, { note: '  kısa  ' }]) {
      const response = await cancel(placement.id, cookie, payload);
      expect(response.status).toBe(400);
    }
    const coded = await cancel(placement.id, cookie, { note: '   kısa   ' });
    expect(coded.body.code).toBe('SHOWCASE_PLACEMENT_CANCEL_NOTE_REQUIRED');

    const after = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } });
    expect(after.status).not.toBe('CANCELLED');
    expect(await ctx.prisma.showcasePlacementCancellation.count()).toBe(0);
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: placement.purchaseId } });
    expect(purchase.manualReviewAt).toBeNull();
  });

  it('cancels with a reason, keeping the actor, the trimmed note and the purchase flag', async () => {
    const placement = await livePlacement();
    const { admin, cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);

    const response = await cancel(placement.id, cookie, { note: '  Müşteri şikâyeti üzerine  ' });

    expect(response.status).toBe(200);
    const row = await ctx.prisma.showcasePlacementCancellation.findUniqueOrThrow({
      where: { placementId: placement.id },
    });
    expect(row).toMatchObject({ actorUserId: admin.id, note: 'Müşteri şikâyeti üzerine' });
    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: placement.purchaseId } });
    expect(purchase.manualReviewAt).not.toBeNull();
    expect(purchase.adminNote).toBe('Müşteri şikâyeti üzerine');
  });
});

describe('POST /admin/showcase/placements/:id/suspend requires a reason (Paket B)', () => {
  async function livePlacement() {
    const category = await createCategory(ctx.prisma, 'Klima');
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const profile = await createDiscoverableProvider(ctx.prisma, {
      userId: providerUser.id,
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
    return placement;
  }

  function suspend(placementId: string, cookie: string, payload: Record<string, unknown>) {
    return request(ctx.server)
      .post(`/admin/showcase/placements/${placementId}/suspend`)
      .set('Cookie', cookie)
      .send(payload);
  }

  it('refuses a missing, blank or too-short note and leaves the run on the air', async () => {
    const placement = await livePlacement();
    const { cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENTS_MODERATE]);

    for (const payload of [{}, { note: null }, { note: '' }, { note: '          ' }, { note: '  kısa  ' }]) {
      const response = await suspend(placement.id, cookie, payload);
      expect(response.status).toBe(400);
    }
    const coded = await suspend(placement.id, cookie, { note: '   kısa   ' });
    expect(coded.body.code).toBe('SHOWCASE_PLACEMENT_SUSPEND_NOTE_REQUIRED');

    const after = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.endAt.getTime()).toBe(placement.endAt.getTime());
    expect(await ctx.prisma.showcasePlacementSuspension.count()).toBe(0);
  });

  it('suspends with a reason, keeping the actor, the trimmed note and the stopped clock', async () => {
    const placement = await livePlacement();
    const { admin, cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENTS_MODERATE]);

    const response = await suspend(placement.id, cookie, { note: '  Şikâyet incelemesi için  ' });

    expect(response.status).toBe(200);
    const row = await ctx.prisma.showcasePlacementSuspension.findFirstOrThrow({ where: { placementId: placement.id } });
    expect(row).toMatchObject({
      actorUserId: admin.id,
      note: 'Şikâyet incelemesi için',
      reason: 'ADMIN_ACTION',
      extendsClock: true,
      endedAt: null,
    });
    const after = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } });
    expect(after.status).toBe('SUSPENDED');
  });
});
