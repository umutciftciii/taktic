import { CustomerOrigin, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

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

/**
 * The raw token is never returned over HTTP and only its SHA-256 hash is
 * stored, so the only way to obtain it — for a test or for a real customer — is
 * the notification. Tests read it from the recording transport, exactly the
 * value that would have been mailed.
 */
function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

async function createGuestRequest(categorySlug: string, overrides: Record<string, unknown> = {}) {
  const response = await request(ctx.server)
    .post('/service-requests')
    .send(serviceRequestPayload(categorySlug, overrides))
    .expect(201);

  const message = ctx.notifications.lastOfTemplate('customer-activation');

  return { request: response.body, activationUrl: message?.actionUrl ?? null, message };
}

describe('guest service request → activation token', () => {
  it('creates a password-less customer and issues exactly one activation token', async () => {
    const category = await createCategory(ctx.prisma);
    const { request: created, activationUrl, message } = await createGuestRequest(category.slug);

    const customer = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: created.customerId },
    });
    expect(customer.role).toBe(UserRole.CUSTOMER);
    expect(customer.passwordHash).toBeNull();
    expect(customer.customerOrigin).toBe(CustomerOrigin.AUTO_CREATED_REQUEST);

    const tokens = await ctx.prisma.customerActivationToken.findMany({
      where: { customerId: customer.id, usedAt: null },
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(activationUrl).toBeTruthy();
    expect(message?.to).toBe(customer.email);
    expect(tokenFromUrl(activationUrl!)).toHaveLength(43);
  });

  it('does not issue a token when the request comes from an activated customer', async () => {
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      customerOrigin: CustomerOrigin.REGISTERED,
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const tokens = await ctx.prisma.customerActivationToken.count({
      where: { customerId: customer.id },
    });
    expect(tokens).toBe(0);
  });
});

describe('activation token consumption', () => {
  it('sets the password, signs the customer in, and cannot be replayed', async () => {
    const category = await createCategory(ctx.prisma);
    const { request: created, activationUrl } = await createGuestRequest(category.slug);
    const token = tokenFromUrl(activationUrl!);

    await request(ctx.server)
      .get('/auth/customer-activation')
      .query({ token })
      .expect(200);

    const activation = await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'YeniSifre123!' })
      .expect(201);

    expect(activation.body.success).toBe(true);
    const setCookie = activation.headers['set-cookie'];
    expect(setCookie).toBeDefined();

    // The session the activation issued is immediately usable.
    const sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
    const me = await request(ctx.server)
      .get('/auth/me')
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(me.body.id).toBe(created.customerId);

    // Replaying the same link fails.
    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'BaskaSifre123!' })
      .expect(400);

    const consumed = await ctx.prisma.customerActivationToken.findFirst({
      where: { customerId: created.customerId },
    });
    expect(consumed?.usedAt).not.toBeNull();
  });

  it('rejects an expired token', async () => {
    const category = await createCategory(ctx.prisma);
    const { request: created, activationUrl } = await createGuestRequest(category.slug);
    const token = tokenFromUrl(activationUrl!);

    await ctx.prisma.customerActivationToken.updateMany({
      where: { customerId: created.customerId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'YeniSifre123!' })
      .expect(400);

    const customer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: created.customerId } });
    expect(customer.passwordHash).toBeNull();
  });

  it('rejects an unknown token', async () => {
    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token: 'not-a-real-token', password: 'YeniSifre123!' })
      .expect(400);
  });
});

describe('activated customer sees only their own data', () => {
  it('lists their own requests and offers but not another customer’s', async () => {
    const category = await createCategory(ctx.prisma);
    const { request: mine, activationUrl } = await createGuestRequest(category.slug);
    const token = tokenFromUrl(activationUrl!);

    const activation = await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'YeniSifre123!' })
      .expect(201);
    const rawCookie = activation.headers['set-cookie'];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)!.split(';')[0]!;

    // A second, unrelated guest request belonging to somebody else.
    const { request: theirs } = await createGuestRequest(category.slug);

    // Give the customer's own request an offer so the offers endpoint has data.
    const provider = await createProviderProfile(ctx.prisma);
    await ctx.prisma.serviceRequest.update({
      where: { id: mine.id },
      data: { status: ServiceRequestStatus.APPROVED },
    });
    await ctx.prisma.offer.create({
      data: {
        providerId: provider.id,
        requestId: mine.id,
        priceAmount: 150000,
        creditCost: 1,
        message: 'Test teklifi',
      },
    });

    const myRequests = await request(ctx.server)
      .get('/service-requests/my')
      .set('Cookie', cookie)
      .expect(200);
    expect(myRequests.body.map((item: { id: string }) => item.id)).toEqual([mine.id]);

    const myOffers = await request(ctx.server)
      .get(`/service-requests/${mine.id}/offers`)
      .set('Cookie', cookie)
      .expect(200);
    expect(myOffers.body).toHaveLength(1);

    await request(ctx.server)
      .get(`/service-requests/${theirs.id}/offers`)
      .set('Cookie', cookie)
      .expect(403);
  });
});

describe('POST /auth/register-customer — claim behaviour', () => {
  it('offers activation instead of a duplicate error for an auto-created account', async () => {
    const category = await createCategory(ctx.prisma);
    const { request: created } = await createGuestRequest(category.slug);
    const customer = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: created.customerId },
    });

    const response = await request(ctx.server)
      .post('/auth/register-customer')
      .send({
        name: 'Yeni Kayıt',
        email: customer.email,
        password: 'BaskaSifre123!',
      })
      .expect(409);

    expect(response.body.code).toBe('ACTIVATION_REQUIRED');
    // No session was handed out and the password was NOT set.
    expect(response.headers['set-cookie']).toBeUndefined();
    const unchanged = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(unchanged.passwordHash).toBeNull();

    // A fresh activation token was issued and the earlier one invalidated.
    const live = await ctx.prisma.customerActivationToken.findMany({
      where: { customerId: customer.id, usedAt: null },
    });
    expect(live).toHaveLength(1);
  });

  it('keeps the plain duplicate error for an already activated account', async () => {
    const existing = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      customerOrigin: CustomerOrigin.REGISTERED,
      password: 'Password123!',
    });

    const response = await request(ctx.server)
      .post('/auth/register-customer')
      .send({ name: 'Taklit', email: existing.email, password: 'BaskaSifre123!' })
      .expect(409);

    expect(response.body.code).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
