import { CustomerOrigin, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_LINK_ALREADY_ACTIVE_CODE,
  CustomerActivationService,
} from '../src/modules/customer-activation/customer-activation.service';
import { REQUEST_STATUS_CHANGED_CODE } from '../src/modules/service-requests/service-requests.service';
import {
  createApprovedRequest,
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 2, the two server-side guards the
 * panel's confirmations stand on.
 *
 * 1. `POST /customers/:id/activation-link`: whether a link is still live is
 *    the API's answer, read under a per-customer issue lock. Without
 *    `replaceExisting: true` a live link is a 409 and nothing is written; two
 *    concurrent issues can never leave two live links.
 * 2. `PATCH /service-requests/:id/status` with `expectedCurrentStatus`: a
 *    move decided against one status is not applied to another. A request
 *    that went live after the panel read it as new is refused with 409
 *    REQUEST_STATUS_CHANGED, with no write and no notification.
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
  ctx.notifications.clear();
});

// ─────────────────────────── activation links ───────────────────────────

async function claimableCustomer() {
  return createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    password: null,
    customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
  });
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

function issue(customerId: string, cookie: string, body?: Record<string, unknown>) {
  const call = request(ctx.server).post(`/customers/${customerId}/activation-link`).set('Cookie', cookie);
  return body === undefined ? call : call.send(body);
}

async function tokens(customerId: string) {
  return ctx.prisma.customerActivationToken.findMany({
    where: { customerId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, usedAt: true, expiresAt: true },
  });
}

async function liveTokenCount(customerId: string) {
  return ctx.prisma.customerActivationToken.count({
    where: { customerId, usedAt: null, expiresAt: { gt: new Date() } },
  });
}

describe('activation link: first issue vs reissue is the API\'s decision', () => {
  it('no live link, no consent: the first link is issued', async () => {
    const customer = await claimableCustomer();
    const cookie = await adminCookie();
    const response = await issue(customer.id, cookie).expect(201);
    expect(response.body.activationUrl).toContain('token=');
    expect(await liveTokenCount(customer.id)).toBe(1);
  });

  it('a live link and no consent (absent or false): 409, and no token is voided or created', async () => {
    const customer = await claimableCustomer();
    const cookie = await adminCookie();
    await issue(customer.id, cookie, {}).expect(201);
    const before = await tokens(customer.id);

    for (const body of [undefined, {}, { replaceExisting: false }]) {
      const refused = await issue(customer.id, cookie, body).expect(409);
      expect(refused.body.code).toBe(ACTIVATION_LINK_ALREADY_ACTIVE_CODE);
    }
    expect(await tokens(customer.id)).toEqual(before);
  });

  it('a mailed link that is still live counts too', async () => {
    const customer = await claimableCustomer();
    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(customer.id);
    const before = await tokens(customer.id);
    const refused = await issue(customer.id, await adminCookie()).expect(409);
    expect(refused.body.code).toBe(ACTIVATION_LINK_ALREADY_ACTIVE_CODE);
    expect(await tokens(customer.id)).toEqual(before);
  });

  it('with consent: the live link is voided and exactly one new one is live', async () => {
    const customer = await claimableCustomer();
    const cookie = await adminCookie();
    const first = await issue(customer.id, cookie).expect(201);
    const second = await issue(customer.id, cookie, { replaceExisting: true }).expect(201);
    expect(second.body.activationUrl).not.toBe(first.body.activationUrl);
    const rows = await tokens(customer.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.usedAt).not.toBeNull();
    expect(rows[1]!.usedAt).toBeNull();
    expect(await liveTokenCount(customer.id)).toBe(1);
  });

  it('a used or expired link is not live: a new first link needs no consent', async () => {
    const used = await claimableCustomer();
    const expired = await claimableCustomer();
    const cookie = await adminCookie();
    await issue(used.id, cookie).expect(201);
    await issue(expired.id, cookie).expect(201);
    await ctx.prisma.customerActivationToken.updateMany({ where: { customerId: used.id }, data: { usedAt: new Date() } });
    await ctx.prisma.customerActivationToken.updateMany({
      where: { customerId: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await issue(used.id, cookie).expect(201);
    await issue(expired.id, cookie).expect(201);
    expect(await liveTokenCount(used.id)).toBe(1);
    expect(await liveTokenCount(expired.id)).toBe(1);
  });

  it('refuses a consent flag that is not a boolean', async () => {
    const customer = await claimableCustomer();
    await issue(customer.id, await adminCookie(), { replaceExisting: 'yes' }).expect(400);
    expect(await tokens(customer.id)).toEqual([]);
  });

  it('concurrent first issues: exactly one succeeds, the rest are 409, one live link', async () => {
    const customer = await claimableCustomer();
    const cookie = await adminCookie();
    const responses = await Promise.all(Array.from({ length: 6 }, () => issue(customer.id, cookie)));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await tokens(customer.id)).toHaveLength(1);
    expect(await liveTokenCount(customer.id)).toBe(1);
  });

  it('concurrent consented reissues: each replaces the one before, never two live links', async () => {
    const customer = await claimableCustomer();
    const cookie = await adminCookie();
    await issue(customer.id, cookie).expect(201);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => issue(customer.id, cookie, { replaceExisting: true })),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(await tokens(customer.id)).toHaveLength(7);
    expect(await liveTokenCount(customer.id)).toBe(1);
  });

  it('the mailed flow (no consent involved) still replaces its own earlier link, one live at a time', async () => {
    const customer = await claimableCustomer();
    const service = ctx.app.get(CustomerActivationService);
    await Promise.all(Array.from({ length: 4 }, () => service.issueForAutoCreatedCustomer(customer.id)));
    expect(await liveTokenCount(customer.id)).toBe(1);
  });
});

// ─────────────────────────── request compare-and-set ───────────────────────────

async function requestIn(status: ServiceRequestStatus) {
  const category = await createCategory(ctx.prisma);
  const row = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
  return ctx.prisma.serviceRequest.update({
    where: { id: row.id },
    data: { status, approvedAt: status === ServiceRequestStatus.APPROVED ? new Date() : null },
  });
}

async function moderatorCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

function patchStatus(id: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server).patch(`/service-requests/${id}/status`).set('Cookie', cookie).send(body);
}

const publishedMails = (requestId: string) =>
  ctx.prisma.notificationLog.count({ where: { requestId, template: { in: ['request-published', 'request-available'] } } });

describe('request status: expectedCurrentStatus is a compare-and-set', () => {
  it('SUBMITTED → IN_REVIEW with the status it was decided against goes through', async () => {
    const row = await requestIn(ServiceRequestStatus.SUBMITTED);
    await patchStatus(row.id, await moderatorCookie(), { status: 'IN_REVIEW', expectedCurrentStatus: 'SUBMITTED' }).expect(200);
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('IN_REVIEW');
  });

  it('decided as SUBMITTED, but the request went live meanwhile: 409, nothing written', async () => {
    const row = await requestIn(ServiceRequestStatus.APPROVED);
    const before = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
    const refused = await patchStatus(row.id, await moderatorCookie(), {
      status: 'IN_REVIEW',
      expectedCurrentStatus: 'SUBMITTED',
    }).expect(409);
    expect(refused.body.code).toBe(REQUEST_STATUS_CHANGED_CODE);
    expect(refused.body.currentStatus).toBe('APPROVED');
    const after = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('APPROVED');
    expect(after.moderatedAt).toEqual(before.moderatedAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('decided as APPROVED (the confirmed unpublish): goes through while it still is', async () => {
    const row = await requestIn(ServiceRequestStatus.APPROVED);
    await patchStatus(row.id, await moderatorCookie(), { status: 'IN_REVIEW', expectedCurrentStatus: 'APPROVED' }).expect(200);
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('IN_REVIEW');
  });

  it('a stale approve books no publication fan-out', async () => {
    const row = await requestIn(ServiceRequestStatus.SUBMITTED);
    const refused = await patchStatus(row.id, await moderatorCookie(), {
      status: 'APPROVED',
      expectedCurrentStatus: 'IN_REVIEW',
    }).expect(409);
    expect(refused.body.code).toBe(REQUEST_STATUS_CHANGED_CODE);
    const after = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('SUBMITTED');
    expect(after.approvedAt).toBeNull();
    expect(await publishedMails(row.id)).toBe(0);
  });

  it('without expectedCurrentStatus the save behaves as before', async () => {
    const row = await requestIn(ServiceRequestStatus.APPROVED);
    await patchStatus(row.id, await moderatorCookie(), { status: 'IN_REVIEW' }).expect(200);
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('IN_REVIEW');
  });

  it('refuses an expectedCurrentStatus that is not a status', async () => {
    const row = await requestIn(ServiceRequestStatus.SUBMITTED);
    await patchStatus(row.id, await moderatorCookie(), { status: 'IN_REVIEW', expectedCurrentStatus: 'LIVE' }).expect(400);
  });

  it('racing an approval: a "new request into review" save never takes the published request down', async () => {
    const cookie = await moderatorCookie();
    for (let round = 0; round < 6; round += 1) {
      const row = await requestIn(ServiceRequestStatus.SUBMITTED);
      const [approve, intoReview] = await Promise.all([
        patchStatus(row.id, cookie, { status: 'APPROVED' }),
        patchStatus(row.id, cookie, { status: 'IN_REVIEW', expectedCurrentStatus: 'SUBMITTED' }),
      ]);
      expect(approve.status).toBe(200);
      expect([200, 409]).toContain(intoReview.status);
      if (intoReview.status === 409) expect(intoReview.body.code).toBe(REQUEST_STATUS_CHANGED_CODE);
      // Whichever ran first, the request ends published: the review step either
      // came before the approval, or was refused after it.
      expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('APPROVED');
    }
  });
});
