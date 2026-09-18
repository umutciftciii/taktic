import { CustomerActivationDelivery, CustomerOrigin, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerActivationService } from '../src/modules/customer-activation/customer-activation.service';
import {
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
 * AUTH-EMAIL-001 — which activation links prove the mailbox.
 *
 * `User.emailVerifiedAt` is a claim that somebody who controls the address
 * followed a link that was sent to it. A link the platform *mailed* is that
 * (single use, never returned over HTTP). A link an operator generated on
 * the admin screen and handed over by hand is not: it proves the operator
 * had the screen, nothing about the inbox. Every token therefore records how
 * it travelled — `delivery` — at issue time, and only EMAIL_DELIVERY stamps
 * the proof when consumed. Issuing a token, opening the link, or failing to
 * consume it never writes the column; an already-present proof is never
 * overwritten; a token from before the column existed (delivery NULL) is
 * treated as unknown, which is no proof.
 */

let ctx: TestContext;
const PASSWORD = 'YeniSifre123!';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  resetAuthThrottle(ctx.app);
});

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

async function claimableCustomer() {
  return createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    password: null,
    customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
  });
}

async function userRow(id: string) {
  return ctx.prisma.user.findUniqueOrThrow({
    where: { id },
    select: { emailVerifiedAt: true, phoneVerifiedAt: true, passwordHash: true },
  });
}

async function tokensOf(customerId: string) {
  return ctx.prisma.customerActivationToken.findMany({
    where: { customerId },
    orderBy: { createdAt: 'asc' },
    select: { delivery: true, usedAt: true, createdById: true },
  });
}

async function activate(token: string, expectStatus = 201) {
  return request(ctx.server)
    .post('/auth/customer-activation')
    .send({ token, password: PASSWORD })
    .expect(expectStatus);
}

function sessionCookie(response: request.Response): string {
  const raw = response.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;
}

describe('an operator-generated link (POST /customers/:id/activation-link)', () => {
  it('is recorded as ADMIN_LINK and its issue writes no proof', async () => {
    const customer = await claimableCustomer();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const issued = await request(ctx.server)
      .post(`/customers/${customer.id}/activation-link`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(201);
    expect(issued.body.activationUrl).toContain('token=');

    expect(await tokensOf(customer.id)).toEqual([
      { delivery: CustomerActivationDelivery.ADMIN_LINK, usedAt: null, createdById: admin.id },
    ]);
    expect((await userRow(customer.id)).emailVerifiedAt).toBeNull();
    // Nothing was mailed: the operator carries the link.
    expect(ctx.notifications.lastOfTemplate('customer-activation')).toBeUndefined();
  });

  it('sets the password and signs the customer in, and leaves emailVerifiedAt NULL everywhere it is read', async () => {
    const customer = await claimableCustomer();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const issued = await request(ctx.server)
      .post(`/customers/${customer.id}/activation-link`)
      .set('Cookie', adminCookie)
      .expect(201);

    // Opening the link (the validate read) writes nothing either.
    await request(ctx.server)
      .get('/auth/customer-activation')
      .query({ token: tokenOf(issued.body.activationUrl) })
      .expect(200);
    expect((await userRow(customer.id)).emailVerifiedAt).toBeNull();

    const activation = await activate(tokenOf(issued.body.activationUrl));
    expect(activation.body.success).toBe(true);

    const row = await userRow(customer.id);
    expect(row.passwordHash).not.toBeNull();
    expect(row.emailVerifiedAt).toBeNull();
    expect((await tokensOf(customer.id))[0]?.usedAt).not.toBeNull();

    // The account's own reads and the operator's directory agree: no proof.
    const cookie = sessionCookie(activation);
    expect((await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200)).body.emailVerifiedAt).toBeNull();
    expect(
      (await request(ctx.server).get('/account/profile').set('Cookie', cookie).expect(200)).body.emailVerifiedAt,
    ).toBeNull();
    const detail = await request(ctx.server)
      .get(`/customers/${customer.id}`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(detail.body.customer.emailVerifiedAt).toBeNull();
    const list = await request(ctx.server).get('/customers?pageSize=50').set('Cookie', adminCookie).expect(200);
    expect(list.body.items.find((item: { id: string }) => item.id === customer.id).emailVerifiedAt).toBeNull();
    // A signed-in customer still needs no proof for anything: the session works.
    await request(ctx.server).get('/service-requests/my').set('Cookie', cookie).expect(200);
  });

  it('re-issued by the operator over a mailed link, the surviving token is the operator\'s and proves nothing', async () => {
    const customer = await claimableCustomer();
    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(customer.id);
    const mailed = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string;
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const issued = await request(ctx.server)
      .post(`/customers/${customer.id}/activation-link`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(201);

    expect((await tokensOf(customer.id)).map((token) => [token.delivery, token.usedAt !== null])).toEqual([
      [CustomerActivationDelivery.EMAIL_DELIVERY, true],
      [CustomerActivationDelivery.ADMIN_LINK, false],
    ]);

    // The mailed link was invalidated by the re-issue; it cannot be spent now.
    await activate(tokenOf(mailed), 400);
    expect((await userRow(customer.id)).emailVerifiedAt).toBeNull();

    await activate(tokenOf(issued.body.activationUrl));
    const row = await userRow(customer.id);
    expect(row.passwordHash).not.toBeNull();
    expect(row.emailVerifiedAt).toBeNull();
  });
});

describe('a mailed link', () => {
  it('from the guest request path is recorded as EMAIL_DELIVERY and stamps the proof only when consumed', async () => {
    const category = await createCategory(ctx.prisma);
    const created = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);
    const customerId = created.body.customerId as string;
    const mailed = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string;
    expect(mailed).toContain('token=');

    expect(await tokensOf(customerId)).toEqual([
      { delivery: CustomerActivationDelivery.EMAIL_DELIVERY, usedAt: null, createdById: null },
    ]);
    // Issued and mailed, not yet consumed: no proof yet.
    expect((await userRow(customerId)).emailVerifiedAt).toBeNull();
    await request(ctx.server).get('/auth/customer-activation').query({ token: tokenOf(mailed) }).expect(200);
    expect((await userRow(customerId)).emailVerifiedAt).toBeNull();

    const before = Date.now();
    await activate(tokenOf(mailed));
    const row = await userRow(customerId);
    expect(row.passwordHash).not.toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.emailVerifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The consumed token's own timestamp is the same instant.
    expect((await tokensOf(customerId))[0]?.usedAt?.getTime()).toBe(row.emailVerifiedAt!.getTime());
  });

  it('from the registration claim path is EMAIL_DELIVERY too', async () => {
    const customer = await claimableCustomer();
    const claim = await request(ctx.server)
      .post('/auth/register-customer')
      .send({ email: customer.email, password: PASSWORD, name: 'Talep Sahibi' })
      .expect(409);
    expect(claim.body.code).toBe('ACTIVATION_REQUIRED');
    const mailed = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string;
    expect(mailed).toBeTruthy();
    expect((await tokensOf(customer.id)).at(-1)?.delivery).toBe(CustomerActivationDelivery.EMAIL_DELIVERY);

    await activate(tokenOf(mailed));
    expect((await userRow(customer.id)).emailVerifiedAt).not.toBeNull();
  });

  it('that fails to be consumed — unknown, expired, replayed — writes nothing', async () => {
    const customer = await claimableCustomer();
    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(customer.id);
    const mailed = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string;

    await activate('not-a-real-token', 400);
    expect((await userRow(customer.id)).emailVerifiedAt).toBeNull();

    await ctx.prisma.customerActivationToken.updateMany({
      where: { customerId: customer.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await activate(tokenOf(mailed), 400);
    expect((await userRow(customer.id)).emailVerifiedAt).toBeNull();
    expect((await userRow(customer.id)).passwordHash).toBeNull();

    // A fresh mailed link, consumed once; the replay changes nothing.
    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(customer.id);
    const fresh = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string;
    await activate(tokenOf(fresh));
    const stamped = (await userRow(customer.id)).emailVerifiedAt;
    expect(stamped).not.toBeNull();
    await activate(tokenOf(fresh), 400);
    expect((await userRow(customer.id)).emailVerifiedAt?.getTime()).toBe(stamped!.getTime());
  });

  it('never overwrites a proof already on file', async () => {
    const customer = await claimableCustomer();
    const earlier = new Date('2026-09-01T10:00:00.000Z');
    await ctx.prisma.user.update({ where: { id: customer.id }, data: { emailVerifiedAt: earlier } });
    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(customer.id);
    const mailed = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string;

    await activate(tokenOf(mailed));
    const row = await userRow(customer.id);
    expect(row.passwordHash).not.toBeNull();
    expect(row.emailVerifiedAt?.getTime()).toBe(earlier.getTime());
  });
});

describe('a token issued before the column existed (delivery NULL)', () => {
  it('still activates the account, and proves nothing', async () => {
    const customer = await claimableCustomer();
    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(customer.id);
    const mailed = ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string;
    // As the migration leaves every pre-existing row.
    await ctx.prisma.customerActivationToken.updateMany({
      where: { customerId: customer.id },
      data: { delivery: null },
    });

    await activate(tokenOf(mailed));
    const row = await userRow(customer.id);
    expect(row.passwordHash).not.toBeNull();
    expect(row.emailVerifiedAt).toBeNull();
  });
});

describe('the phone proof (PR #88) is untouched by any of this', () => {
  it('stays NULL through an activation of either kind', async () => {
    const customer = await claimableCustomer();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const issued = await request(ctx.server)
      .post(`/customers/${customer.id}/activation-link`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(201);
    await activate(tokenOf(issued.body.activationUrl));
    expect((await userRow(customer.id)).phoneVerifiedAt).toBeNull();

    const other = await claimableCustomer();
    await ctx.app.get(CustomerActivationService).issueForAutoCreatedCustomer(other.id);
    await activate(tokenOf(ctx.notifications.lastOfTemplate('customer-activation')?.actionUrl as string));
    const row = await userRow(other.id);
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.phoneVerifiedAt).toBeNull();
  });
});
