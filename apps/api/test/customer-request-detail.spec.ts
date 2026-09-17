import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * `GET /service-requests/my/:id` — one request, read by its owner.
 *
 * The success screen renders the request's real state from this call rather
 * than from a URL flag, so the endpoint has to be safe to point an id at: a
 * request that is not this customer's answers exactly like one that does not
 * exist, and every other caller is stopped by the guards before any lookup.
 * The row is the same projection the customer's own list returns — the two
 * screens must never disagree about a status, a reference or a vitrin lead.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  // The settings singleton survives resetDatabase; leave the switch off for
  // whichever spec file runs next.
  await setAutoPublish(false);
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await setAutoPublish(false);
  resetAuthThrottle(ctx.app);
});

async function setAutoPublish(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      unviewedOfferRefundWindowHours: 48,
      marketplaceAutoPublishEnabled: enabled,
    },
    update: { marketplaceAutoPublishEnabled: enabled },
  });
}

describe('GET /service-requests/my/:id', () => {
  it('returns the owner their request, shaped exactly like the list row', async () => {
    const category = await createCategory(ctx.prisma, 'Sahip', { offerCreditCost: 1 });
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: owner.id,
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: created.id },
      data: {
        preferredDate: new Date('2026-09-15T00:00:00.000Z'),
        preferredDateEnd: new Date('2026-09-20T00:00:00.000Z'),
      },
    });
    const cookie = await loginAs(ctx.prisma, owner.id);

    const detail = await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', cookie)
      .expect(200);
    const list = await request(ctx.server)
      .get('/service-requests/my')
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.id).toBe(created.id);
    expect(detail.body.status).toBe('APPROVED');
    expect(detail.body.requestNumber).toBe(created.requestNumber);
    expect(detail.body.preferredDate).toBe('2026-09-15T00:00:00.000Z');
    expect(detail.body.preferredDateEnd).toBe('2026-09-20T00:00:00.000Z');
    expect(detail.body.showcaseLead).toBeNull();
    expect(detail.body).toEqual(list.body[0]);
  });

  it('answers 404 for another customer\'s request, exactly like an unknown id', async () => {
    const category = await createCategory(ctx.prisma, 'Başkası', { offerCreditCost: 1 });
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: owner.id,
    });
    const cookie = await loginAs(ctx.prisma, other.id);

    const foreign = await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', cookie)
      .expect(404);
    const unknown = await request(ctx.server)
      .get('/service-requests/my/clzzzzzzzzzzzzzzzzzzzzzzz')
      .set('Cookie', cookie)
      .expect(404);

    // The same body for both: nothing in the answer says which case it was.
    expect(foreign.body).toEqual(unknown.body);
  });

  it('is closed to providers, admins and anonymous callers', async () => {
    const category = await createCategory(ctx.prisma, 'Roller', { offerCreditCost: 1 });
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: owner.id,
    });
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', await loginAs(ctx.prisma, provider.id))
      .expect(403);
    await request(ctx.server)
      .get(`/service-requests/my/${created.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(403);
    await request(ctx.server).get(`/service-requests/my/${created.id}`).expect(401);
  });

  /*
   * The two reads a customer's screens are worded from — the public switch
   * before the form is sent, the request's own status after — come from the
   * same setting through the same method. What the policy said when the
   * request was posted is the status the detail reports; the web never has to
   * combine the two, and must not.
   */
  it('projects the status the switch decided when the request was posted', async () => {
    const category = await createCategory(ctx.prisma, 'Anahtar', { offerCreditCost: 1 });
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, owner.id);

    // Switch off: the policy says so, and the request is read back waiting.
    expect((await request(ctx.server).get('/marketplace-publish-policy').expect(200)).body).toEqual({
      autoPublishEnabled: false,
    });
    const waiting = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(category.slug))
      .expect(201);
    const waitingDetail = await request(ctx.server)
      .get(`/service-requests/my/${waiting.body.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(waitingDetail.body.status).toBe('SUBMITTED');

    // Switch on: the policy says so, and a new request is read back live —
    // while the one posted before the flip stays exactly as it was.
    await setAutoPublish(true);
    expect((await request(ctx.server).get('/marketplace-publish-policy').expect(200)).body).toEqual({
      autoPublishEnabled: true,
    });
    const live = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(category.slug))
      .expect(201);
    const liveDetail = await request(ctx.server)
      .get(`/service-requests/my/${live.body.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(liveDetail.body.status).toBe('APPROVED');
    expect(
      (
        await request(ctx.server)
          .get(`/service-requests/my/${waiting.body.id}`)
          .set('Cookie', cookie)
          .expect(200)
      ).body.status,
    ).toBe('SUBMITTED');

    // The detail carries no more about the switch than the status: nothing
    // names the setting, and a stranger to the request still gets 404.
    expect(liveDetail.body).not.toHaveProperty('autoPublishEnabled');
    expect(liveDetail.body).not.toHaveProperty('marketplaceAutoPublishEnabled');
    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await request(ctx.server)
      .get(`/service-requests/my/${live.body.id}`)
      .set('Cookie', await loginAs(ctx.prisma, other.id))
      .expect(404);
  });
});
