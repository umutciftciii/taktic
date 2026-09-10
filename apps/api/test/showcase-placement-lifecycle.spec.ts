import {
  ProviderStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShowcasePlacementExpiryService } from '../src/modules/showcase/showcase-placement-expiry.service';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  serviceAreaRow,
  type TestContext,
} from './harness';

/**
 * The clock rule, which is the core of this phase.
 *
 * One sentence decides every case in this file: **the platform's own obstacles
 * stop a run's clock; the provider's own actions do not.**
 *
 * Stopping it for our obstacles is the only honest answer to somebody who paid
 * for thirty days and got twenty-seven because an operator pulled the shelf.
 * Letting it run for their own actions is the answer to a different question:
 * if archiving a card froze the clock, a run bought in February could be parked
 * and spent in June — a dated placement turned into an undated voucher, which is
 * not what was sold.
 *
 * The cost of the second half is real and accepted, and one case below asserts
 * it plainly: a provider who archives a card for a while loses that time.
 *
 * Every verdict is **snapshotted** onto the suspension row rather than derived
 * when it closes, so a policy change next year cannot rewrite what happened to a
 * run last March. A CHECK enforces the consequence independently, and the last
 * case here proves it at the database.
 */
let ctx: TestContext;
let expiry: ShowcasePlacementExpiryService;

beforeAll(async () => {
  ctx = await createTestApp();
  expiry = ctx.app.get(ShowcasePlacementExpiryService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

const DAY = 24 * 60 * 60 * 1000;

async function live(options: { durationDays?: number } = {}) {
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
  const pkg = await createShowcasePackage(ctx.prisma, {
    durationDays: options.durationDays ?? 30,
  });
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: profile.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });

  const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

  return {
    category,
    profile,
    card,
    version,
    pkg,
    placement,
    providerCookie: await loginAs(ctx.prisma, providerUser.id),
    adminCookie: await loginAs(ctx.prisma, adminUser.id),
  };
}

function read(placementId: string) {
  return ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placementId } });
}

/** Rewinds an open suspension so resuming it looks like `days` have passed. */
async function backdateSuspension(placementId: string, days: number) {
  const startedAt = new Date(Date.now() - days * DAY);

  await ctx.prisma.showcasePlacement.update({
    where: { id: placementId },
    data: { suspendedAt: startedAt },
  });
  await ctx.prisma.showcasePlacementSuspension.updateMany({
    where: { placementId, endedAt: null },
    data: { startedAt },
  });
}

describe('a settled payment produces exactly one live run', () => {
  it('activates it, sets the window from the moment it was paid, and writes its shelves', async () => {
    const { placement, pkg } = await live({ durationDays: 30 });

    expect(placement.status).toBe('ACTIVE');
    expect(placement.durationDaysSnapshot).toBe(30);
    expect(placement.endAt.getTime() - placement.startAt.getTime()).toBe(30 * DAY);
    expect(placement.priceAmountSnapshot).toBe(pkg.priceAmount);
    expect(placement.shelves).toHaveLength(1);
    expect(placement.shelves[0]?.active).toBe(true);
  });

  it('refuses a second run against the same payment', async () => {
    const { placement } = await live();

    // `ShowcasePlacement.purchaseId` is unique: one settled payment, one run.
    await expect(
      ctx.prisma.showcasePlacement.create({
        data: {
          purchaseId: placement.purchaseId,
          providerId: placement.providerId,
          showcasePackageId: placement.showcasePackageId,
          cardId: placement.cardId,
          pinnedVersionId: placement.pinnedVersionId,
          categoryId: placement.categoryId,
          kindSnapshot: placement.kindSnapshot,
          packageNameSnapshot: placement.packageNameSnapshot,
          priceAmountSnapshot: placement.priceAmountSnapshot,
          durationDaysSnapshot: placement.durationDaysSnapshot,
          // Copied so the row is complete in every other respect: what must
          // refuse this insert is the unique index on `purchaseId`, and a row
          // that also violated a NOT NULL would pass the assertion for the
          // wrong reason.
          priceTermsVersionSnapshot: placement.priceTermsVersionSnapshot,
          priceTermsTextSnapshot: placement.priceTermsTextSnapshot,
          startAt: placement.startAt,
          endAt: placement.endAt,
        },
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'P2002' }),
    );
  });
});

describe('the clock stops for the platform', () => {
  it("gives the days back when an operator's hold is lifted", async () => {
    const { placement, adminCookie } = await live();
    const before = (await read(placement.id)).endAt;

    const suspended = await request(ctx.server)
      .post(`/admin/showcase/placements/${placement.id}/suspend`)
      .set('Cookie', adminCookie)
      .send({ note: 'İnceleme' });
    expect(suspended.status).toBe(200);

    await backdateSuspension(placement.id, 3);

    const resumed = await request(ctx.server)
      .post(`/admin/showcase/placements/${placement.id}/resume`)
      .set('Cookie', adminCookie)
      .send({});
    expect(resumed.status).toBe(200);

    const after = await read(placement.id);
    expect(after.status).toBe('ACTIVE');
    // Three days off the air, three days back. Compared with a tolerance
    // because the resume reads its own `now`.
    expect(after.endAt.getTime() - before.getTime()).toBeGreaterThan(3 * DAY - 60_000);
    expect(after.totalExtendedMs).toBeGreaterThan(3 * DAY - 60_000);

    const suspension = await ctx.prisma.showcasePlacementSuspension.findFirstOrThrow({
      where: { placementId: placement.id },
    });
    expect(suspension.reason).toBe('ADMIN_ACTION');
    expect(suspension.extendsClock).toBe(true);
    expect(suspension.endAtAfter?.getTime()).toBe(after.endAt.getTime());
  });

  it('gives the days back when a closed category is reopened', async () => {
    const { placement, category, adminCookie } = await live();
    const before = (await read(placement.id)).endAt;

    const closed = await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.INACTIVE });
    expect(closed.status).toBe(200);

    const held = await read(placement.id);
    expect(held.status).toBe('SUSPENDED');
    expect(held.suspendReason).toBe('CATEGORY_CLOSED');

    await backdateSuspension(placement.id, 3);

    await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.ACTIVE });

    const after = await read(placement.id);
    expect(after.status).toBe('ACTIVE');
    expect(after.endAt.getTime() - before.getTime()).toBeGreaterThan(3 * DAY - 60_000);
  });
});

describe("the clock runs through the provider's own actions", () => {
  it('does not extend a run while its card is archived', async () => {
    const { placement, card, profile, providerCookie } = await live();
    const before = (await read(placement.id)).endAt;

    const archived = await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/cards/${card.id}/archive`)
      .set('Cookie', providerCookie)
      .send({});
    expect(archived.status).toBe(200);

    const held = await read(placement.id);
    expect(held.status).toBe('SUSPENDED');
    expect(held.suspendReason).toBe('CARD_ARCHIVED');

    await backdateSuspension(placement.id, 3);

    await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/cards/${card.id}/unarchive`)
      .set('Cookie', providerCookie)
      .send({});

    const after = await read(placement.id);
    expect(after.status).toBe('ACTIVE');
    // Three days archived is three days of the run, gone. This is the price of
    // a run not being parkable, and it is the intended outcome.
    expect(after.endAt.getTime()).toBe(before.getTime());
    expect(after.totalExtendedMs).toBe(0);

    const suspension = await ctx.prisma.showcasePlacementSuspension.findFirstOrThrow({
      where: { placementId: placement.id },
    });
    expect(suspension.extendsClock).toBe(false);
    expect(suspension.endAtAfter?.getTime()).toBe(before.getTime());
  });

  it('does not extend a run while the provider has narrowed it out of coverage', async () => {
    const { placement, profile, providerCookie } = await live();
    const before = (await read(placement.id)).endAt;

    // The profile save is what re-judges every run against the new coverage.
    const narrowed = await request(ctx.server)
      .patch(`/providers/${profile.id}`)
      .set('Cookie', providerCookie)
      .send(await profilePayload(profile.id, [{ city: 'Ankara', district: 'Çankaya' }]));
    expect(narrowed.status).toBe(200);

    const held = await read(placement.id);
    expect(held.status).toBe('SUSPENDED');
    expect(held.suspendReason).toBe('AREA_NO_LONGER_COVERED');

    await backdateSuspension(placement.id, 3);

    await request(ctx.server)
      .patch(`/providers/${profile.id}`)
      .set('Cookie', providerCookie)
      .send(await profilePayload(profile.id, [{ city: 'İstanbul', district: null }]));

    const after = await read(placement.id);
    expect(after.status).toBe('ACTIVE');
    expect(after.endAt.getTime()).toBe(before.getTime());
  });

  it('does not extend a run while the provider is suspended', async () => {
    const { placement, profile, adminCookie } = await live();
    const before = (await read(placement.id)).endAt;

    await request(ctx.server)
      .patch(`/providers/${profile.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ProviderStatus.SUSPENDED, moderationNote: 'İnceleme' });

    const held = await read(placement.id);
    expect(held.status).toBe('SUSPENDED');
    expect(held.suspendReason).toBe('PROVIDER_NOT_APPROVED');

    await backdateSuspension(placement.id, 3);

    await request(ctx.server)
      .patch(`/providers/${profile.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ProviderStatus.APPROVED });

    const after = await read(placement.id);
    expect(after.status).toBe('ACTIVE');
    // A sanction is not rewarded with banked time.
    expect(after.endAt.getTime()).toBe(before.getTime());
  });
});

describe('the database half of the clock rule', () => {
  it('refuses a suspension that did not stop the clock but moved the end date', async () => {
    const { placement } = await live();
    const now = new Date();

    await expect(
      ctx.prisma.showcasePlacementSuspension.create({
        data: {
          placementId: placement.id,
          reason: 'CARD_ARCHIVED',
          extendsClock: false,
          startedAt: now,
          endedAt: now,
          endAtBefore: placement.endAt,
          // A day of free time, refused by
          // `ShowcasePlacementSuspension_extension_matches_flag`.
          endAtAfter: new Date(placement.endAt.getTime() + DAY),
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses two open suspensions on one run', async () => {
    const { placement, adminCookie } = await live();

    await request(ctx.server)
      .post(`/admin/showcase/placements/${placement.id}/suspend`)
      .set('Cookie', adminCookie)
      .send({});

    await expect(
      ctx.prisma.showcasePlacementSuspension.create({
        data: {
          placementId: placement.id,
          reason: 'SYSTEM_PUBLISH_BLOCK',
          extendsClock: true,
          endAtBefore: placement.endAt,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('what an operator may and may not resume', () => {
  it("refuses to resume a hold the operator did not place", async () => {
    const { placement, card, profile, providerCookie, adminCookie } = await live();

    await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/cards/${card.id}/archive`)
      .set('Cookie', providerCookie)
      .send({});

    const response = await request(ctx.server)
      .post(`/admin/showcase/placements/${placement.id}/resume`)
      .set('Cookie', adminCookie)
      .send({});

    // The other five reasons lift when the condition behind them goes away.
    // Resuming one here would put a card back on a shelf that is still closed.
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_PLACEMENT_NOT_RESUMABLE');
  });

  it('cancels a run without moving any money, and flags the purchase for a person', async () => {
    const { placement, adminCookie } = await live();

    const response = await request(ctx.server)
      .post(`/admin/showcase/placements/${placement.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ note: 'Talep üzerine' });

    expect(response.status).toBe(200);

    const after = await read(placement.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelledAt).not.toBeNull();

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: placement.purchaseId },
    });
    // The flag, not a refund: money is moved by people, through the same manual
    // path a chargeback takes.
    expect(purchase.manualReviewReason).toBe('SHOWCASE_PLACEMENT_CANCELLED');
    expect(purchase.manualReviewAt).not.toBeNull();
    expect(purchase.refundedAt).toBeNull();

    const shelves = await ctx.prisma.showcasePlacementShelf.findMany({
      where: { placementId: placement.id },
    });
    expect(shelves.every((shelf) => !shelf.active)).toBe(true);
  });
});

describe('the expiry sweeper', () => {
  it('closes a run whose time is up and takes its shelves down', async () => {
    const { placement } = await live();
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { startAt: new Date(Date.now() - 40 * DAY), endAt: new Date(Date.now() - DAY) },
    });

    const result = await expiry.execute();

    expect(result.expired).toBe(1);
    expect((await read(placement.id)).status).toBe('EXPIRED');

    const shelves = await ctx.prisma.showcasePlacementShelf.findMany({
      where: { placementId: placement.id },
    });
    expect(shelves.every((shelf) => !shelf.active)).toBe(true);
  });

  it('changes nothing on a second pass', async () => {
    const { placement } = await live();
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { startAt: new Date(Date.now() - 40 * DAY), endAt: new Date(Date.now() - DAY) },
    });

    await expiry.execute();
    const second = await expiry.execute();

    // Every write is a conditional UPDATE, so a second runner — or a second
    // tick — finds nothing left to do.
    expect(second.expired).toBe(0);
  });

  it('frees the card for its next run once the old one has expired', async () => {
    const { placement, card, profile, pkg, providerCookie } = await live();
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { startAt: new Date(Date.now() - 40 * DAY), endAt: new Date(Date.now() - DAY) },
    });
    await expiry.execute();

    const response = await request(ctx.server)
      .post(`/providers/${profile.id}/showcase/placements/checkout`)
      .set('Cookie', providerCookie)
      .send({ cardId: card.id, showcasePackageId: pkg.id });

    expect(response.status).toBe(201);
  });
});

/** The whole profile body, with only the service areas changed. */
async function profilePayload(
  providerId: string,
  areas: Array<{ city: string; district?: string | null }>,
) {
  const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
    where: { id: providerId },
    include: { serviceCategories: true },
  });

  return {
    businessName: provider.businessName,
    contactName: provider.contactName,
    phone: provider.phone,
    email: provider.email,
    city: provider.city,
    district: provider.district,
    categoryIds: provider.serviceCategories.map((binding) => binding.categoryId),
    serviceAreas: areas.map((area) => {
      const row = serviceAreaRow(area);
      return { city: row.city, district: row.district, neighborhood: row.neighborhood };
    }),
  };
}
