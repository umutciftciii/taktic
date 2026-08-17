import { ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  providerPayload,
  resetDatabase,
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
});

/** Everything the public projection must never leak. */
const PRIVATE_FIELDS = [
  'user',
  'email',
  'phone',
  'contactName',
  'taxType',
  'taxNumber',
  'addressNote',
  'moderationNote',
  'rejectionReason',
] as const;

describe('GET /providers/:id — public projection', () => {
  it('hides account, contact, tax and moderation fields from anonymous callers', async () => {
    const provider = await createProviderProfile(ctx.prisma);

    const response = await request(ctx.server).get(`/providers/${provider.id}`).expect(200);

    expect(response.body.visibility).toBe('public');
    for (const field of PRIVATE_FIELDS) {
      expect(response.body).not.toHaveProperty(field);
    }

    // The business card itself is still readable.
    expect(response.body.businessName).toBe(provider.businessName);
    expect(response.body.city).toBe(provider.city);
    expect(Array.isArray(response.body.serviceAreas)).toBe(true);

    // Nothing sensitive may hide inside a nested object either.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(provider.phone);
    expect(serialized).not.toContain(provider.email);
    expect(serialized).not.toContain(provider.taxNumber);
    expect(serialized).not.toContain('İç moderasyon notu');
  });

  it('hides the same fields from an unrelated signed-in customer', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.visibility).toBe('public');
    for (const field of PRIVATE_FIELDS) {
      expect(response.body).not.toHaveProperty(field);
    }
  });

  it('hides the same fields from a different provider account', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const otherProviderUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createProviderProfile(ctx.prisma, { userId: otherProviderUser.id });
    const cookie = await loginAs(ctx.prisma, otherProviderUser.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.visibility).toBe('public');
    expect(response.body).not.toHaveProperty('phone');
  });

  it('returns 404 for an unknown id', async () => {
    await request(ctx.server).get('/providers/does-not-exist').expect(404);
  });
});

describe('GET /providers/:id — only approved profiles are publicly discoverable', () => {
  const NON_PUBLIC_STATUSES = [
    ProviderStatus.DRAFT,
    ProviderStatus.PENDING_REVIEW,
    ProviderStatus.REJECTED,
    ProviderStatus.SUSPENDED,
  ] as const;

  it('serves an APPROVED profile to anonymous callers', async () => {
    const provider = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.APPROVED,
    });

    const response = await request(ctx.server).get(`/providers/${provider.id}`).expect(200);
    expect(response.body.visibility).toBe('public');
    expect(response.body.businessName).toBe(provider.businessName);
  });

  for (const status of NON_PUBLIC_STATUSES) {
    it(`hides a ${status} profile from anonymous callers with 404, not 403`, async () => {
      const provider = await createProviderProfile(ctx.prisma, { status });

      const response = await request(ctx.server).get(`/providers/${provider.id}`).expect(404);
      // The body must not hint that the row exists — id enumeration should look
      // identical to hitting a random id.
      expect(JSON.stringify(response.body)).not.toContain(provider.businessName);
    });

    it(`hides a ${status} profile from an unrelated customer`, async () => {
      const provider = await createProviderProfile(ctx.prisma, { status });
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
      const cookie = await loginAs(ctx.prisma, customer.id);

      await request(ctx.server)
        .get(`/providers/${provider.id}`)
        .set('Cookie', cookie)
        .expect(404);
    });

    it(`hides a ${status} profile from a different provider account`, async () => {
      const provider = await createProviderProfile(ctx.prisma, { status });
      const otherProviderUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
      const cookie = await loginAs(ctx.prisma, otherProviderUser.id);

      await request(ctx.server)
        .get(`/providers/${provider.id}`)
        .set('Cookie', cookie)
        .expect(404);
    });

    it(`still shows a ${status} profile to its owner`, async () => {
      const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
      const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status });
      const cookie = await loginAs(ctx.prisma, owner.id);

      const response = await request(ctx.server)
        .get(`/providers/${provider.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.visibility).toBe('owner');
      expect(response.body.status).toBe(status);
      expect(response.body.phone).toBe(provider.phone);
    });

    it(`still shows a ${status} profile to SUPER_ADMIN`, async () => {
      const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
      const provider = await createProviderProfile(ctx.prisma, { status });
      const cookie = await loginAs(ctx.prisma, admin.id);

      const response = await request(ctx.server)
        .get(`/providers/${provider.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.visibility).toBe('admin');
      expect(response.body.status).toBe(status);
      expect(response.body.moderationNote).toBe('İç moderasyon notu');
    });
  }
});

describe('GET /providers/:id — private projection', () => {
  it('gives the owning provider its own contact and tax fields', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const cookie = await loginAs(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.visibility).toBe('owner');
    expect(response.body.phone).toBe(provider.phone);
    expect(response.body.email).toBe(provider.email);
    expect(response.body.contactName).toBe(provider.contactName);
    expect(response.body.taxNumber).toBe(provider.taxNumber);
  });

  it('gives SUPER_ADMIN the full record including moderation fields', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const provider = await createProviderProfile(ctx.prisma);
    const cookie = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.visibility).toBe('admin');
    expect(response.body.phone).toBe(provider.phone);
    expect(response.body.taxNumber).toBe(provider.taxNumber);
    expect(response.body.moderationNote).toBe('İç moderasyon notu');
  });
});

describe('PATCH /providers/:id — unclaimed (guest) profiles', () => {
  it('rejects anonymous edits', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });

    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .send(providerPayload());

    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);

    const unchanged = await ctx.prisma.providerProfile.findUnique({ where: { id: provider.id } });
    expect(unchanged?.businessName).toBe(provider.businessName);
  });

  it('rejects a signed-in customer', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send(providerPayload())
      .expect(403);
  });

  it('rejects a signed-in provider that does not own it', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    const otherProvider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, otherProvider.id);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send(providerPayload())
      .expect(403);
  });

  it('allows SUPER_ADMIN', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    const payload = { ...providerPayload([category.id]), businessName: 'Admin Düzenledi' };

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send(payload)
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUnique({ where: { id: provider.id } });
    expect(updated?.businessName).toBe('Admin Düzenledi');
  });

  it('still lets the owning provider edit a claimed profile', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), businessName: 'Sahibi Düzenledi' })
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUnique({ where: { id: provider.id } });
    expect(updated?.businessName).toBe('Sahibi Düzenledi');
  });
});

describe('POST /providers — one profile per account', () => {
  it('returns 409 on a second profile and leaves exactly one row', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send(providerPayload([category.id]))
      .expect(201);

    await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send(providerPayload([category.id]))
      .expect(409);

    const count = await ctx.prisma.providerProfile.count({ where: { userId: owner.id } });
    expect(count).toBe(1);
  });

  it('is enforced by a database constraint, not only by the service check', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createProviderProfile(ctx.prisma, { userId: owner.id });

    await expect(createProviderProfile(ctx.prisma, { userId: owner.id })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('still allows several unclaimed guest applications', async () => {
    await createProviderProfile(ctx.prisma, { userId: null });
    await createProviderProfile(ctx.prisma, { userId: null });

    const count = await ctx.prisma.providerProfile.count({ where: { userId: null } });
    expect(count).toBe(2);
  });
});
