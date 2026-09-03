import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';

/**
 * The refund window as a setting, and as a promise an offer carries.
 *
 * Two things are under test and the second is the one that matters. A super
 * admin can change how long a customer has to open an offer — that is the easy
 * half. The hard half is that changing it must reach nothing that already
 * exists: an offer created at 48 hours is a 48-hour offer forever, and the
 * worker has to keep paying it on that schedule while paying a newer 72-hour
 * offer on its own.
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

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;
const HOUR = 60 * 60 * 1000;

async function superAdminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { cookie: await loginAs(ctx.prisma, admin.id), admin };
}

function setWindowHours(cookie: string, hours: number | string) {
  return request(ctx.server)
    .put('/operations-settings')
    .set('Cookie', cookie)
    .send({ unviewedOfferRefundWindowHours: hours });
}

/**
 * One offer, created through the real endpoint.
 *
 * Deliberately not a prisma.offer.create: the snapshot is written by the
 * offer-creation path, and a fixture that wrote the columns itself would test
 * the fixture.
 */
async function createOffer(categoryId: string, requestId: string) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId,
  });
  await grantCredits(ctx.prisma, provider.id, STARTING_CREDITS);
  const cookie = await loginAs(ctx.prisma, ownerUser.id);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return { provider, offerId: created.body.id as string };
}

async function offerSnapshot(offerId: string) {
  return ctx.prisma.offer.findUniqueOrThrow({
    where: { id: offerId },
    select: {
      submittedAt: true,
      unviewedRefundPolicy: true,
      unviewedRefundWindowHours: true,
      unviewedRefundEligibleAt: true,
    },
  });
}

async function marketplace() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });

  return { category, serviceRequest };
}

describe('the refund window as a setting', () => {
  it('reads as the product default until an operator saves one', async () => {
    const { cookie } = await superAdminCookie();

    const response = await request(ctx.server)
      .get('/operations-settings')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.configured).toBe(false);
    expect(response.body.unviewedOfferRefundWindowHours).toBe(48);
    expect(response.body.unviewedOfferRefundNotice).toContain('48 saat');
    // Nothing was written to answer the question.
    expect(await ctx.prisma.operationsSettings.count()).toBe(0);
  });

  it('publishes the window and its sentence without a session', async () => {
    const { cookie } = await superAdminCookie();
    await setWindowHours(cookie, 72).expect(200);

    const response = await request(ctx.server).get('/refund-policy').expect(200);

    expect(response.body.unviewedOfferRefundWindowHours).toBe(72);
    expect(response.body.unviewedOfferRefundNotice).toBe(
      'Teklifiniz müşteri tarafından 72 saat içinde görüntülenmezse krediniz otomatik olarak iade edilir.',
    );
    // The public endpoint carries the term and nothing about who set it.
    expect(response.body.recentChanges).toBeUndefined();
    expect(response.body.updatedBy).toBeUndefined();
  });

  it('saves a whole-hour value and reports it back', async () => {
    const { cookie } = await superAdminCookie();

    const response = await setWindowHours(cookie, 72).expect(200);

    expect(response.body.configured).toBe(true);
    expect(response.body.unviewedOfferRefundWindowHours).toBe(72);
    expect(response.body.unviewedOfferRefundNotice).toContain('72 saat');
  });

  it('refuses a fractional, out-of-range or non-numeric window', async () => {
    const { cookie } = await superAdminCookie();

    const fractional = await setWindowHours(cookie, 48.5).expect(400);
    expect(String(fractional.body.message)).toContain('tam saat');

    const tooSmall = await setWindowHours(cookie, 0).expect(400);
    expect(String(tooSmall.body.message)).toContain('en az 1 saat');

    const tooLarge = await setWindowHours(cookie, 721).expect(400);
    expect(String(tooLarge.body.message)).toContain('en fazla 720 saat');

    await setWindowHours(cookie, 'kırk sekiz').expect(400);

    // A refused save writes nothing at all — not the row, not an audit entry.
    expect(await ctx.prisma.operationsSettings.count()).toBe(0);
    expect(await ctx.prisma.operationsSettingsChange.count()).toBe(0);
  });
});

describe('who may read and change the window', () => {
  it('refuses an anonymous caller', async () => {
    await request(ctx.server).get('/operations-settings').expect(401);
    await request(ctx.server)
      .put('/operations-settings')
      .send({ unviewedOfferRefundWindowHours: 72 })
      .expect(401);
  });

  // Every role but SUPER_ADMIN, which is every role this schema has: the window
  // is a commercial term, and the response also carries the trail of who
  // changed the platform's terms.
  for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER] as const) {
    it(`refuses a ${role}, both reading and writing`, async () => {
      const user = await createUser(ctx.prisma, { role });
      const cookie = await loginAs(ctx.prisma, user.id);

      await request(ctx.server).get('/operations-settings').set('Cookie', cookie).expect(403);
      await setWindowHours(cookie, 72).expect(403);

      expect(await ctx.prisma.operationsSettings.count()).toBe(0);
    });
  }
});

describe('the audit trail of changes', () => {
  it('records the old value, the new value, the operator and the moment', async () => {
    const { cookie, admin } = await superAdminCookie();

    await setWindowHours(cookie, 72).expect(200);
    await setWindowHours(cookie, 24).expect(200);

    const changes = await ctx.prisma.operationsSettingsChange.findMany({
      orderBy: { createdAt: 'asc' },
    });

    expect(changes).toHaveLength(2);
    // NULL exactly once: before the first save the effective value was the
    // product default rather than something an operator chose.
    expect(changes[0]).toMatchObject({
      setting: 'unviewedOfferRefundWindowHours',
      previousValue: null,
      newValue: '72',
      changedById: admin.id,
    });
    expect(changes[1]).toMatchObject({
      previousValue: '72',
      newValue: '24',
      changedById: admin.id,
    });
    expect(changes[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('does not record a save that changes nothing', async () => {
    const { cookie } = await superAdminCookie();

    await setWindowHours(cookie, 72).expect(200);
    await setWindowHours(cookie, 72).expect(200);

    expect(await ctx.prisma.operationsSettingsChange.count()).toBe(1);
  });

  it('shows the trail on the admin read, newest first', async () => {
    const { cookie, admin } = await superAdminCookie();
    await setWindowHours(cookie, 72).expect(200);
    await setWindowHours(cookie, 96).expect(200);

    const response = await request(ctx.server)
      .get('/operations-settings')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.recentChanges).toHaveLength(2);
    expect(response.body.recentChanges[0].newValue).toBe('96');
    expect(response.body.recentChanges[0].previousValue).toBe('72');
    expect(response.body.recentChanges[0].changedBy.id).toBe(admin.id);
    expect(response.body.updatedBy.id).toBe(admin.id);
  });
});

describe('the window an offer is created with', () => {
  it('snapshots the default window and the exact refund moment', async () => {
    const { category, serviceRequest } = await marketplace();

    const { offerId } = await createOffer(category.id, serviceRequest.id);

    const offer = await offerSnapshot(offerId);
    expect(offer.unviewedRefundPolicy).toBe(true);
    expect(offer.unviewedRefundWindowHours).toBe(48);
    expect(offer.unviewedRefundEligibleAt?.getTime()).toBe(
      offer.submittedAt.getTime() + 48 * HOUR,
    );
  });

  it('governs the next offer only, and leaves the previous one at its own window', async () => {
    const { category, serviceRequest } = await marketplace();
    const first = await createOffer(category.id, serviceRequest.id);

    const { cookie } = await superAdminCookie();
    await setWindowHours(cookie, 72).expect(200);

    const secondRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const second = await createOffer(category.id, secondRequest.id);

    const before = await offerSnapshot(first.offerId);
    const after = await offerSnapshot(second.offerId);

    expect(before.unviewedRefundWindowHours).toBe(48);
    expect(before.unviewedRefundEligibleAt?.getTime()).toBe(
      before.submittedAt.getTime() + 48 * HOUR,
    );
    expect(after.unviewedRefundWindowHours).toBe(72);
    expect(after.unviewedRefundEligibleAt?.getTime()).toBe(
      after.submittedAt.getTime() + 72 * HOUR,
    );
  });

  it('tells the provider the window their own offer was sold under', async () => {
    const { category, serviceRequest } = await marketplace();
    const first = await createOffer(category.id, serviceRequest.id);

    const { cookie } = await superAdminCookie();
    await setWindowHours(cookie, 72).expect(200);

    const response = await request(ctx.server)
      .get(`/offers/${first.offerId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.refundEligibility.windowHours).toBe(48);
    expect(response.body.refundEligibility.eligibleAt).not.toBeNull();
  });
});

describe('the worker reads each offer own schedule', () => {
  it('pays the offer whose moment has passed and leaves the one whose has not', async () => {
    const { category, serviceRequest } = await marketplace();
    const shortWindow = await createOffer(category.id, serviceRequest.id);

    const { cookie } = await superAdminCookie();
    await setWindowHours(cookie, 96).expect(200);

    const secondRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const longWindow = await createOffer(category.id, secondRequest.id);

    // Both submitted 60 hours ago. Under one window that is past the moment,
    // under the other it is not — and the offers were created minutes apart.
    const submittedAt = new Date(Date.now() - 60 * HOUR);
    for (const offerId of [shortWindow.offerId, longWindow.offerId]) {
      const snapshot = await offerSnapshot(offerId);
      await ctx.prisma.offer.update({
        where: { id: offerId },
        data: {
          submittedAt,
          unviewedRefundEligibleAt: new Date(
            submittedAt.getTime() + snapshot.unviewedRefundWindowHours! * HOUR,
          ),
        },
      });
    }

    const result = await ctx.app.get(UnviewedOfferRefundService).execute();

    expect(result.refunded).toBe(1);
    expect(
      result.results.find((item) => item.offerId === shortWindow.offerId)?.status,
    ).toBe('REFUNDED');
    expect(result.results.some((item) => item.offerId === longWindow.offerId)).toBe(false);

    const paid = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: shortWindow.offerId } });
    const unpaid = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: longWindow.offerId } });
    expect(paid.creditRefundedTransactionId).not.toBeNull();
    expect(unpaid.creditRefundedTransactionId).toBeNull();
  });

  it('never pays an in-policy offer that carries no refund moment', async () => {
    const { category, serviceRequest } = await marketplace();
    const { offerId } = await createOffer(category.id, serviceRequest.id);

    // The state the migration's backfill exists to prevent. It must read as
    // "do not pay", never as "pay now".
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: {
        submittedAt: new Date(Date.now() - 500 * HOUR),
        unviewedRefundWindowHours: null,
        unviewedRefundEligibleAt: null,
      },
    });

    const dryRun = await ctx.app.get(UnviewedOfferRefundService).dryRun();
    expect(dryRun.eligibleCount).toBe(0);
    expect(dryRun.skippedSummary.noSchedule).toBe(1);

    const result = await ctx.app.get(UnviewedOfferRefundService).execute();
    expect(result.refunded).toBe(0);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.creditRefundedTransactionId).toBeNull();
  });

  it('leaves an offer created before the policy outside it, however old', async () => {
    const { category, serviceRequest } = await marketplace();
    const { offerId } = await createOffer(category.id, serviceRequest.id);

    // Exactly what the previous migration left behind: no opt-in, no schedule.
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: {
        unviewedRefundPolicy: false,
        unviewedRefundWindowHours: null,
        unviewedRefundEligibleAt: null,
        submittedAt: new Date(Date.now() - 500 * HOUR),
      },
    });

    const dryRun = await ctx.app.get(UnviewedOfferRefundService).dryRun();
    expect(dryRun.eligibleCount).toBe(0);
    expect(dryRun.skippedSummary.outOfPolicy).toBe(1);
    expect(dryRun.skippedSummary.noSchedule).toBe(0);

    const result = await ctx.app.get(UnviewedOfferRefundService).execute();
    expect(result.refunded).toBe(0);
  });

  it('reports the current window for new offers, and each offer own window per row', async () => {
    const { category, serviceRequest } = await marketplace();
    const { offerId } = await createOffer(category.id, serviceRequest.id);

    const { cookie } = await superAdminCookie();
    await setWindowHours(cookie, 96).expect(200);

    const submittedAt = new Date(Date.now() - 60 * HOUR);
    await ctx.prisma.offer.update({
      where: { id: offerId },
      data: {
        submittedAt,
        unviewedRefundEligibleAt: new Date(submittedAt.getTime() + 48 * HOUR),
      },
    });

    const dryRun = await ctx.app.get(UnviewedOfferRefundService).dryRun();

    expect(dryRun.currentWindowHours).toBe(96);
    expect(dryRun.items).toHaveLength(1);
    expect(dryRun.items[0]!.windowHours).toBe(48);
    expect(dryRun.items[0]!.eligibleAt).not.toBeNull();
  });
});
