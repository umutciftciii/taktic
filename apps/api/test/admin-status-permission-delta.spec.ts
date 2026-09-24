import {
  AdminPermission,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createOfferPackage,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * BUG-RBAC-STATUS-001: the edit routes cannot be used to change a status
 * without the status permission.
 *
 * `PATCH /categories/:id` and `PATCH /credit-packages/:id` carry business
 * fields and the status in one body. The route admits a holder of either
 * permission. The service compares the request with the stored row and
 * requires WRITE for a business delta, STATUS for a status delta, and both for
 * both. A value sent back unchanged is not a delta.
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
  return loginAs(ctx.prisma, admin.id);
}

async function superAdmin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, user.id);
}

describe('PATCH /categories/:id', () => {
  const WRITE = AdminPermission.CATEGORIES_WRITE;
  const STATUS = AdminPermission.CATEGORIES_STATUS;

  async function seed() {
    return createCategory(ctx.prisma, 'Klima', {
      offerCreditCost: 3,
      status: ServiceCategoryStatus.ACTIVE,
    });
  }

  function patch(id: string, cookie: string, body: Record<string, unknown>) {
    return request(ctx.server).patch(`/categories/${id}`).set('Cookie', cookie).send(body);
  }

  function read(id: string) {
    return ctx.prisma.serviceCategory.findUniqueOrThrow({ where: { id } });
  }

  it('WRITE alone: a business field changes, a status change is 403 and changes nothing', async () => {
    const category = await seed();
    const cookie = await staff([WRITE]);

    const renamed = await patch(category.id, cookie, { name: 'Yeni ad' });
    expect(renamed.status).toBe(200);
    expect((await read(category.id)).name).toBe('Yeni ad');

    for (const body of [
      { status: ServiceCategoryStatus.INACTIVE },
      { isActive: false },
      { name: 'Birlikte', status: ServiceCategoryStatus.INACTIVE },
    ]) {
      const refused = await patch(category.id, cookie, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
      expect(refused.body.code).toBe('INSUFFICIENT_PERMISSION');
    }
    const after = await read(category.id);
    expect(after.status).toBe(ServiceCategoryStatus.ACTIVE);
    expect(after.isActive).toBe(true);
    // The combined request was refused whole: its name did not land either.
    expect(after.name).toBe('Yeni ad');
  });

  it('STATUS alone: the status changes, a business-field change is 403 and changes nothing', async () => {
    const category = await seed();
    const cookie = await staff([STATUS]);

    const closed = await patch(category.id, cookie, { status: ServiceCategoryStatus.INACTIVE });
    expect(closed.status).toBe(200);
    const afterClose = await read(category.id);
    expect(afterClose.status).toBe(ServiceCategoryStatus.INACTIVE);
    expect(afterClose.isActive).toBe(false);

    for (const body of [
      { name: 'Yeni ad' },
      { sortOrder: 9 },
      { name: 'Yeni ad', status: ServiceCategoryStatus.ACTIVE },
    ]) {
      const refused = await patch(category.id, cookie, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
    }
    const after = await read(category.id);
    expect(after.name).toBe(category.name);
    expect(after.sortOrder).toBe(category.sortOrder);
    expect(after.status).toBe(ServiceCategoryStatus.INACTIVE);
  });

  it('WRITE + STATUS: a combined change succeeds', async () => {
    const category = await seed();
    const cookie = await staff([WRITE, STATUS]);

    const response = await patch(category.id, cookie, {
      name: 'Birlikte',
      status: ServiceCategoryStatus.INACTIVE,
    });
    expect(response.status).toBe(200);
    const after = await read(category.id);
    expect(after.name).toBe('Birlikte');
    expect(after.status).toBe(ServiceCategoryStatus.INACTIVE);
  });

  it('neither permission: refused at the door, nothing changes', async () => {
    const category = await seed();
    const cookie = await staff([AdminPermission.CATALOG_READ]);

    for (const body of [{ name: 'X' }, { status: ServiceCategoryStatus.INACTIVE }, {}]) {
      const refused = await patch(category.id, cookie, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
    }
    const after = await read(category.id);
    expect(after.name).toBe(category.name);
    expect(after.status).toBe(ServiceCategoryStatus.ACTIVE);
  });

  it('an unchanged status sent with a business change needs WRITE only', async () => {
    const category = await seed();
    const cookie = await staff([WRITE]);

    // The shape the admin form sends: every field, the status echoed back.
    const echoed = await patch(category.id, cookie, {
      name: 'Form',
      status: ServiceCategoryStatus.ACTIVE,
    });
    expect(echoed.status).toBe(200);
    // The legacy vocabulary, echoed the same way.
    const legacy = await patch(category.id, cookie, { sortOrder: 4, isActive: true });
    expect(legacy.status).toBe(200);

    const after = await read(category.id);
    expect(after.name).toBe('Form');
    expect(after.sortOrder).toBe(4);
    expect(after.status).toBe(ServiceCategoryStatus.ACTIVE);
  });

  it('a request that changes nothing is answered as before, for either permission', async () => {
    const category = await seed();

    for (const cookie of [await staff([WRITE]), await staff([STATUS]), await superAdmin()]) {
      for (const body of [
        {},
        { name: category.name, status: category.status, offerCreditCost: 3 },
      ]) {
        const response = await patch(category.id, cookie, body);
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(response.body.id).toBe(category.id);
      }
    }
    const after = await read(category.id);
    expect(after.name).toBe(category.name);
    expect(after.status).toBe(ServiceCategoryStatus.ACTIVE);
  });

  it('SUPER_ADMIN: every valid change succeeds, and the status route still works', async () => {
    const category = await seed();
    const cookie = await superAdmin();

    expect((await patch(category.id, cookie, { name: 'SA' })).status).toBe(200);
    expect((await patch(category.id, cookie, { status: ServiceCategoryStatus.DRAFT })).status).toBe(200);
    expect(
      (await patch(category.id, cookie, { name: 'SA 2', status: ServiceCategoryStatus.ACTIVE })).status,
    ).toBe(200);
    const viaStatusRoute = await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', cookie)
      .send({ status: ServiceCategoryStatus.INACTIVE });
    expect(viaStatusRoute.status).toBe(200);

    const after = await read(category.id);
    expect(after.name).toBe('SA 2');
    expect(after.status).toBe(ServiceCategoryStatus.INACTIVE);
  });

  it('a stale status echoed after someone else changed it is a status change, and is refused', async () => {
    const category = await seed();
    const writer = await staff([WRITE]);
    const closer = await staff([STATUS]);

    // The writer's form was rendered while the category was ACTIVE.
    expect(
      (await patch(category.id, closer, { status: ServiceCategoryStatus.INACTIVE })).status,
    ).toBe(200);

    // Submitting it now would put ACTIVE back without CATEGORIES_STATUS.
    const stale = await patch(category.id, writer, {
      name: 'Eski form',
      status: ServiceCategoryStatus.ACTIVE,
    });
    expect(stale.status).toBe(403);
    const after = await read(category.id);
    expect(after.status).toBe(ServiceCategoryStatus.INACTIVE);
    expect(after.name).toBe(category.name);
  });

  it('under a real race the writer never reopens what the status holder closed', async () => {
    const writer = await staff([WRITE]);
    const closer = await staff([STATUS]);

    for (let round = 0; round < 6; round += 1) {
      const category = await seed();
      const [closed, written] = await Promise.all([
        patch(category.id, closer, { status: ServiceCategoryStatus.INACTIVE }),
        patch(category.id, writer, { name: `Yarış ${round}`, status: ServiceCategoryStatus.ACTIVE }),
      ]);

      // Either the writer read ACTIVE (its status was an echo, not written)
      // or it read INACTIVE (its status was a change it may not make). In no
      // order does its request carry the status.
      expect([200, 403, 409]).toContain(written.status);
      const after = await read(category.id);
      if (closed.status === 200) {
        expect(after.status, `round ${round}`).toBe(ServiceCategoryStatus.INACTIVE);
      } else {
        expect(closed.status).toBe(409);
        expect(after.status, `round ${round}`).toBe(ServiceCategoryStatus.ACTIVE);
      }
      if (written.status !== 200) {
        expect(after.name).toBe(category.name);
      }
    }
  });

  it('closing a category on the edit route suspends its vitrin runs, as the status route does', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
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
    const cookie = await staff([STATUS]);

    expect((await patch(category.id, cookie, { status: ServiceCategoryStatus.INACTIVE })).status).toBe(200);
    const held = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } });
    expect(held.status).toBe('SUSPENDED');
    expect(held.suspendReason).toBe('CATEGORY_CLOSED');

    expect((await patch(category.id, cookie, { status: ServiceCategoryStatus.ACTIVE })).status).toBe(200);
    const resumed = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } });
    expect(resumed.status).toBe('ACTIVE');
  });
});

describe('PATCH /credit-packages/:id', () => {
  const WRITE = AdminPermission.CREDIT_PACKAGES_WRITE;
  const STATUS = AdminPermission.CREDIT_PACKAGES_STATUS;

  function patch(id: string, cookie: string, body: Record<string, unknown>) {
    return request(ctx.server).patch(`/credit-packages/${id}`).set('Cookie', cookie).send(body);
  }

  function read(id: string) {
    return ctx.prisma.offerCreditPackage.findUniqueOrThrow({ where: { id } });
  }

  it('WRITE alone: a business field changes, an isActive change is 403 and changes nothing', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { priceAmount: 100_000, isActive: true });
    const cookie = await staff([WRITE]);

    expect((await patch(pkg.id, cookie, { priceAmount: 120_000 })).status).toBe(200);
    expect((await read(pkg.id)).priceAmount).toBe(120_000);

    for (const body of [{ isActive: false }, { priceAmount: 130_000, isActive: false }]) {
      const refused = await patch(pkg.id, cookie, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
    }
    const after = await read(pkg.id);
    expect(after.isActive).toBe(true);
    expect(after.priceAmount).toBe(120_000);
  });

  it('STATUS alone: isActive changes, a business-field change is 403 and changes nothing', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { priceAmount: 100_000, isActive: true });
    const cookie = await staff([STATUS]);

    expect((await patch(pkg.id, cookie, { isActive: false })).status).toBe(200);
    expect((await read(pkg.id)).isActive).toBe(false);

    for (const body of [{ priceAmount: 120_000 }, { name: 'Yeni', isActive: true }]) {
      const refused = await patch(pkg.id, cookie, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
    }
    const after = await read(pkg.id);
    expect(after.priceAmount).toBe(100_000);
    expect(after.name).toBe(pkg.name);
    expect(after.isActive).toBe(false);
  });

  it('WRITE + STATUS: a combined change succeeds', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { isActive: true });
    const cookie = await staff([WRITE, STATUS]);

    expect((await patch(pkg.id, cookie, { name: 'Birlikte', isActive: false })).status).toBe(200);
    const after = await read(pkg.id);
    expect(after.name).toBe('Birlikte');
    expect(after.isActive).toBe(false);
  });

  it('neither permission: refused at the door, nothing changes', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { isActive: true });
    const cookie = await staff([AdminPermission.CREDIT_PACKAGES_READ]);

    for (const body of [{ name: 'X' }, { isActive: false }, {}]) {
      expect((await patch(pkg.id, cookie, body)).status, JSON.stringify(body)).toBe(403);
    }
    const after = await read(pkg.id);
    expect(after.name).toBe(pkg.name);
    expect(after.isActive).toBe(true);
  });

  it('an unchanged isActive sent with a business change needs WRITE only', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { isActive: true });
    const cookie = await staff([WRITE]);

    const response = await patch(pkg.id, cookie, {
      name: 'Form',
      priceAmount: 150_000,
      currency: 'TRY',
      isActive: true,
    });
    expect(response.status).toBe(200);
    const after = await read(pkg.id);
    expect(after.name).toBe('Form');
    expect(after.priceAmount).toBe(150_000);
    expect(after.isActive).toBe(true);
  });

  it('a request that changes nothing is answered as before, for either permission', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { isActive: true });

    for (const cookie of [await staff([WRITE]), await staff([STATUS]), await superAdmin()]) {
      for (const body of [
        {},
        { name: pkg.name, priceAmount: pkg.priceAmount, isActive: true },
        // Same scope for a one-time package: none.
        { scopeCategoryIds: [] },
      ]) {
        const response = await patch(pkg.id, cookie, body);
        expect(response.status, JSON.stringify(body)).toBe(200);
      }
    }
    expect((await read(pkg.id)).isActive).toBe(true);
  });

  it('SUPER_ADMIN: every valid change succeeds', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { isActive: true });
    const cookie = await superAdmin();

    expect((await patch(pkg.id, cookie, { name: 'SA', isActive: false })).status).toBe(200);
    expect((await patch(pkg.id, cookie, { isActive: true })).status).toBe(200);
    expect((await patch(pkg.id, cookie, { sortOrder: 7 })).status).toBe(200);
    const after = await read(pkg.id);
    expect(after.name).toBe('SA');
    expect(after.isActive).toBe(true);
    expect(after.sortOrder).toBe(7);
  });

  it('a scope change is a business change', async () => {
    const eligible = await createCategory(ctx.prisma, 'Kapsam', {
      offerCreditCost: 2,
      unlimitedPackageEligible: true,
    });
    const other = await createCategory(ctx.prisma, 'Kapsam 2', {
      offerCreditCost: 2,
      unlimitedPackageEligible: true,
    });
    const pkg = await createOfferPackage(ctx.prisma, {
      type: 'CATEGORY_UNLIMITED',
      scopeCategoryIds: [eligible.id],
    });

    const statusOnly = await staff([STATUS]);
    // The same scope, reordered or not, is not a change…
    expect((await patch(pkg.id, statusOnly, { scopeCategoryIds: [eligible.id] })).status).toBe(200);
    // …a different one is.
    expect(
      (await patch(pkg.id, statusOnly, { scopeCategoryIds: [eligible.id, other.id] })).status,
    ).toBe(403);

    const writer = await staff([WRITE]);
    expect(
      (await patch(pkg.id, writer, { scopeCategoryIds: [other.id, eligible.id] })).status,
    ).toBe(200);
    const scope = await ctx.prisma.offerPackageScopeCategory.findMany({ where: { packageId: pkg.id } });
    expect(scope.map((entry) => entry.categoryId).sort()).toEqual([eligible.id, other.id].sort());
  });

  it('a stale isActive echoed after someone else changed it is refused', async () => {
    const pkg = await createOfferPackage(ctx.prisma, { isActive: true });
    const writer = await staff([WRITE]);
    const switcher = await staff([STATUS]);

    expect((await patch(pkg.id, switcher, { isActive: false })).status).toBe(200);
    const stale = await patch(pkg.id, writer, { name: 'Eski form', isActive: true });
    expect(stale.status).toBe(403);
    const after = await read(pkg.id);
    expect(after.isActive).toBe(false);
    expect(after.name).toBe(pkg.name);
  });

  it('under a real race the writer never switches back on what the status holder switched off', async () => {
    const writer = await staff([WRITE]);
    const switcher = await staff([STATUS]);

    for (let round = 0; round < 6; round += 1) {
      const pkg = await createOfferPackage(ctx.prisma, { isActive: true });
      const [switched, written] = await Promise.all([
        patch(pkg.id, switcher, { isActive: false }),
        patch(pkg.id, writer, { name: `Yarış ${round}`, isActive: true }),
      ]);

      expect([200, 403, 409]).toContain(written.status);
      const after = await read(pkg.id);
      if (switched.status === 200) {
        expect(after.isActive, `round ${round}`).toBe(false);
      } else {
        expect(switched.status).toBe(409);
        expect(after.isActive, `round ${round}`).toBe(true);
      }
    }
  });
});
