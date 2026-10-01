import { AdminPermission, ServiceCategoryKind, ShowcasePlacementStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * API-HARDENING-001 (1/4): a cancelled vitrin run records who cancelled it.
 *
 * The row is written in the transaction that moves the placement to
 * CANCELLED, so there is no cancelled run with a missing actor from here on —
 * and no actor is ever invented for a run cancelled before this existed.
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

async function livePlacement() {
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
  return placement;
}

async function staff(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

function cancel(placementId: string, cookie: string, note?: string) {
  return request(ctx.server)
    .post(`/admin/showcase/placements/${placementId}/cancel`)
    .set('Cookie', cookie)
    .send(note === undefined ? {} : { note });
}

describe('cancelling a run records the operator', () => {
  it('writes the actor and the trimmed note in the same transaction as the status change', async () => {
    const placement = await livePlacement();
    const { admin, cookie } = await staff([
      AdminPermission.SHOWCASE_PLACEMENT_CANCEL,
      AdminPermission.SHOWCASE_PLACEMENTS_READ,
    ]);

    const response = await cancel(placement.id, cookie, '  Müşteri şikâyeti üzerine  ');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CANCELLED');
    expect(response.body.cancellation).toEqual({
      actor: { id: admin.id, name: admin.name },
      note: 'Müşteri şikâyeti üzerine',
      cancelledAt: expect.any(String),
    });

    const rows = await ctx.prisma.showcasePlacementCancellation.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ placementId: placement.id, actorUserId: admin.id });

    const detail = await request(ctx.server)
      .get(`/admin/showcase/placements/${placement.id}`)
      .set('Cookie', cookie);
    expect(detail.body.cancellation.actor.id).toBe(admin.id);
  });

  it('refuses a cancellation with no note and records nothing (ADMIN-DESTRUCTIVE-CONFIRMATION-001)', async () => {
    const placement = await livePlacement();
    const { cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);

    expect((await cancel(placement.id, cookie)).status).toBe(400);

    expect(await ctx.prisma.showcasePlacementCancellation.count()).toBe(0);
    expect((await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } })).status).toBe(
      ShowcasePlacementStatus.ACTIVE,
    );
  });

  it('refuses a repeated cancel and keeps the first operator as the record', async () => {
    const placement = await livePlacement();
    const first = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);
    const second = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);

    expect((await cancel(placement.id, first.cookie, 'İlk operatörün iptali')).status).toBe(200);
    const again = await cancel(placement.id, second.cookie, 'İkinci operatörün iptali');

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SHOWCASE_PLACEMENT_NOT_CANCELLABLE');
    const rows = await ctx.prisma.showcasePlacementCancellation.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: first.admin.id, note: 'İlk operatörün iptali' });
  });

  it('lets exactly one of two concurrent cancels win, with one audit row', async () => {
    const placement = await livePlacement();
    const a = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);
    const b = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);

    const results = await Promise.all([cancel(placement.id, a.cookie, 'Eşzamanlı iptal A'), cancel(placement.id, b.cookie, 'Eşzamanlı iptal B')]);
    const statuses = results.map((result) => result.status).sort();

    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(409);
    const rows = await ctx.prisma.showcasePlacementCancellation.findMany();
    expect(rows).toHaveLength(1);
    const winner = results.find((result) => result.status === 200)!;
    expect(rows[0]?.actorUserId).toBe(winner.body.cancellation.actor.id);
  });

  it('writes nothing for a run that cannot be cancelled', async () => {
    const placement = await livePlacement();
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { status: ShowcasePlacementStatus.EXPIRED },
    });
    const { cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);

    expect((await cancel(placement.id, cookie, 'Süresi geçmiş yerleşim')).status).toBe(409);
    expect(await ctx.prisma.showcasePlacementCancellation.count()).toBe(0);
  });

  it('refuses an operator without the cancel permission and records nothing', async () => {
    const placement = await livePlacement();
    const { cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENTS_MODERATE]);

    expect((await cancel(placement.id, cookie, 'Yetkisiz iptal denemesi')).status).toBe(403);
    expect(await ctx.prisma.showcasePlacementCancellation.count()).toBe(0);
    expect((await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } })).status).toBe(
      ShowcasePlacementStatus.ACTIVE,
    );
  });
});

describe('a run cancelled before the operator was recorded', () => {
  it('answers with no cancellation record instead of a guessed actor', async () => {
    const placement = await livePlacement();
    // The pre-migration shape: CANCELLED with no audit row.
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { status: ShowcasePlacementStatus.CANCELLED, cancelledAt: new Date() },
    });
    const { cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENTS_READ]);

    const detail = await request(ctx.server)
      .get(`/admin/showcase/placements/${placement.id}`)
      .set('Cookie', cookie);

    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('CANCELLED');
    expect(detail.body.cancellation).toBeNull();
  });
});

describe('the database keeps the record honest', () => {
  it('refuses a cancellation row for a run that is not cancelled', async () => {
    const placement = await livePlacement();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await expect(
      ctx.prisma.showcasePlacementCancellation.create({
        data: { placementId: placement.id, actorUserId: admin.id },
      }),
    ).rejects.toThrow(/requires a CANCELLED placement/);
  });

  it('refuses to edit or delete a recorded cancellation', async () => {
    const placement = await livePlacement();
    const { cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);
    await cancel(placement.id, cookie, 'Kalıcı iptal kaydı');
    const other = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await expect(
      ctx.prisma.showcasePlacementCancellation.update({
        where: { placementId: placement.id },
        data: { actorUserId: other.id },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.prisma.showcasePlacementCancellation.delete({ where: { placementId: placement.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps the actor: the account cannot be deleted from under the record', async () => {
    const placement = await livePlacement();
    const { admin, cookie } = await staff([AdminPermission.SHOWCASE_PLACEMENT_CANCEL]);
    await cancel(placement.id, cookie, 'Hesap silme denemesi');

    await ctx.prisma.session.deleteMany({ where: { userId: admin.id } });
    await ctx.prisma.adminRoleAssignment.deleteMany({ where: { userId: admin.id } });
    await ctx.prisma.adminRoleAuditLog.deleteMany({
      where: { OR: [{ actorId: admin.id }, { targetUserId: admin.id }] },
    });
    await expect(ctx.prisma.user.delete({ where: { id: admin.id } })).rejects.toThrow(
      /ShowcasePlacementCancellation_actorUserId_fkey/,
    );
  });
});
