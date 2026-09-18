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
  type TestContext,
} from './harness';

/**
 * Where "this e-mail / this phone is verified" comes from, and who may read it.
 *
 * Two canonical columns and nothing else: `User.emailVerifiedAt` and
 * `User.phoneVerifiedAt`. A request whose own `phoneVerifiedAt` is stamped, or
 * a consumed PhoneVerification row on it, says that a *request's* contact
 * number was proven once — it says nothing about the account's number today,
 * and no badge may be minted from it. An account created before either column
 * existed carries NULL in both and is shown as unverified, not as verified.
 *
 * Readers: the operator's customer list and detail (both timestamps, one
 * query each — no per-row lookups), the account's own `/auth/me` and
 * `/account/profile`. The admin's request read, the provider's surfaces and
 * an anonymous caller get no new field.
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
  resetAuthThrottle(ctx.app);
});

const EMAIL_AT = new Date('2026-09-10T08:00:00.000Z');
const PHONE_AT = new Date('2026-09-12T09:30:00.000Z');

async function stamp(userId: string, data: { emailVerifiedAt?: Date | null; phoneVerifiedAt?: Date | null }) {
  await ctx.prisma.user.update({ where: { id: userId }, data });
}

describe('GET /customers (operator list)', () => {
  it('carries both timestamps per row, from the account columns only', async () => {
    const both = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'İkisi de' });
    await stamp(both.id, { emailVerifiedAt: EMAIL_AT, phoneVerifiedAt: PHONE_AT });
    const emailOnly = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Yalnız e-posta' });
    await stamp(emailOnly.id, { emailVerifiedAt: EMAIL_AT });
    const legacy = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Eski kayıt' });

    // The trap: a request of the legacy customer verified by one-time code,
    // with its PhoneVerification row — on the request, never on the account.
    const category = await createCategory(ctx.prisma, 'Rozet', { offerCreditCost: 1 });
    const legacyRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: legacy.id,
      customerPhone: legacy.phone as string,
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: legacyRequest.id },
      data: { phoneVerifiedAt: PHONE_AT },
    });
    await ctx.prisma.phoneVerification.create({
      data: {
        normalizedPhone: legacy.phone as string,
        codeHash: 'x',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: PHONE_AT,
        requestId: legacyRequest.id,
      },
    });

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const res = await request(ctx.server)
      .get('/customers?pageSize=50')
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);

    const byId = new Map<string, Record<string, unknown>>(
      (res.body.items as Array<Record<string, unknown>>).map((row) => [row.id as string, row]),
    );
    expect(byId.get(both.id)).toMatchObject({
      emailVerifiedAt: EMAIL_AT.toISOString(),
      phoneVerifiedAt: PHONE_AT.toISOString(),
    });
    expect(byId.get(emailOnly.id)).toMatchObject({
      emailVerifiedAt: EMAIL_AT.toISOString(),
      phoneVerifiedAt: null,
    });
    // The request-level proof does not reach the account row.
    expect(byId.get(legacy.id)).toMatchObject({ emailVerifiedAt: null, phoneVerifiedAt: null });
  });
});

describe('GET /customers/:id (operator detail)', () => {
  it('carries the timestamps on the customer object, and null for an unproven channel', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await stamp(customer.id, { phoneVerifiedAt: PHONE_AT });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const res = await request(ctx.server)
      .get(`/customers/${customer.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);

    expect(res.body.customer).toMatchObject({
      id: customer.id,
      emailVerifiedAt: null,
      phoneVerifiedAt: PHONE_AT.toISOString(),
    });
  });

  it('does not mint an account badge from a verified request of that customer', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const category = await createCategory(ctx.prisma, 'Rozet', { offerCreditCost: 1 });
    const verifiedRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
      customerPhone: customer.phone as string,
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: verifiedRequest.id },
      data: { phoneVerifiedAt: PHONE_AT },
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    const res = await request(ctx.server)
      .get(`/customers/${customer.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);

    expect(res.body.customer.phoneVerifiedAt).toBeNull();
    expect(res.body.customer.emailVerifiedAt).toBeNull();
  });
});

describe('the account\'s own reads', () => {
  it('/auth/me and /account/profile carry the session user\'s own timestamps', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await stamp(customer.id, { emailVerifiedAt: EMAIL_AT, phoneVerifiedAt: PHONE_AT });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const me = await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body).toMatchObject({
      id: customer.id,
      emailVerifiedAt: EMAIL_AT.toISOString(),
      phoneVerifiedAt: PHONE_AT.toISOString(),
    });

    const profile = await request(ctx.server)
      .get('/account/profile')
      .set('Cookie', cookie)
      .expect(200);
    expect(profile.body).toMatchObject({
      id: customer.id,
      emailVerifiedAt: EMAIL_AT.toISOString(),
      phoneVerifiedAt: PHONE_AT.toISOString(),
    });
  });

  it('reads null for an account that never proved either channel', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const me = await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.emailVerifiedAt).toBeNull();
    expect(me.body.phoneVerifiedAt).toBeNull();
    const profile = await request(ctx.server)
      .get('/account/profile')
      .set('Cookie', cookie)
      .expect(200);
    expect(profile.body.emailVerifiedAt).toBeNull();
    expect(profile.body.phoneVerifiedAt).toBeNull();
  });
});

describe('everybody else', () => {
  it('sees no verification field about a customer', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await stamp(customer.id, { emailVerifiedAt: EMAIL_AT, phoneVerifiedAt: PHONE_AT });
    const category = await createCategory(ctx.prisma, 'Sızıntı', { offerCreditCost: 1 });
    const created = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });

    // The operator's request read names the customer, but not their proofs —
    // those live on the customer screens.
    const adminRead = await request(ctx.server)
      .get(`/service-requests/${created.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);
    expect(adminRead.body.customer).not.toHaveProperty('emailVerifiedAt');
    expect(adminRead.body.customer).not.toHaveProperty('phoneVerifiedAt');

    // The customer directory is the operator's alone.
    await request(ctx.server)
      .get('/customers')
      .set('Cookie', await loginAs(ctx.prisma, provider.id))
      .expect(403);
    await request(ctx.server)
      .get(`/customers/${customer.id}`)
      .set('Cookie', await loginAs(ctx.prisma, provider.id))
      .expect(403);
    await request(ctx.server)
      .get(`/customers/${customer.id}`)
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .expect(403);
    await request(ctx.server).get('/customers').expect(401);
    await request(ctx.server).get('/auth/me').expect(401);
    await request(ctx.server).get('/account/profile').expect(401);
  });
});
