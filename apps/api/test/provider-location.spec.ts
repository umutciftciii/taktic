import { UserRole } from '@prisma/client';
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
import { listNeighborhoods } from '../src/modules/locations/turkey-locations';

/**
 * A provider's address and service areas, checked against the same canonical
 * list a customer's request is.
 *
 * The application form offers dependent selects now, so an impossible pair
 * cannot be composed by hand. That is a convenience and not a guarantee: POST
 * /providers takes a plain JSON body, so every case below posts what a tampered
 * client would send.
 *
 * The stakes are higher here than on a request. Discovery compares a provider's
 * service area against a request's city and district as text
 * (`matchesProviderArea`), so a provider stored at a place that does not exist
 * is not slightly wrong — it is invisible to every request, with nothing on any
 * screen to say why.
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

async function postApplication(overrides: Record<string, unknown>) {
  const category = await createCategory(ctx.prisma);
  return request(ctx.server)
    .post('/providers')
    .send({ ...providerPayload([category.id]), ...overrides });
}

describe('POST /providers business address', () => {
  it('accepts a real pair and stores the canonical spelling', async () => {
    const response = await postApplication({ city: 'istanbul', district: 'kadıköy' });

    expect(response.status).toBe(201);

    const stored = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: response.body.id as string },
      select: { city: true, district: true },
    });
    expect(stored).toEqual({ city: 'İstanbul', district: 'Kadıköy' });
  });

  it('refuses a district that belongs to a different province', async () => {
    const response = await postApplication({ city: 'İstanbul', district: 'Çankaya' });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses a province that does not exist', async () => {
    const response = await postApplication({ city: 'Kadıköy', district: 'Kadıköy' });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses an invented district in a real province', async () => {
    const response = await postApplication({ city: 'İstanbul', district: 'Kadıköy-7f3a11' });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });
});

describe('POST /providers service areas', () => {
  it('stores a canonical area and keeps a province-only area meaning the whole province', async () => {
    const response = await postApplication({
      serviceAreas: [
        { city: 'istanbul', district: 'kadıköy' },
        // No district: the matching rule reads this as all of Ankara, and that
        // has to keep resolving rather than becoming an invalid area.
        { city: 'Ankara' },
      ],
    });

    expect(response.status).toBe(201);

    const areas = await ctx.prisma.providerServiceArea.findMany({
      where: { providerId: response.body.id as string },
      orderBy: { city: 'asc' },
      select: { city: true, district: true, neighborhood: true },
    });
    expect(areas).toEqual([
      { city: 'Ankara', district: null, neighborhood: null },
      { city: 'İstanbul', district: 'Kadıköy', neighborhood: null },
    ]);
  });

  it('refuses an area whose district belongs to another province', async () => {
    const response = await postApplication({
      serviceAreas: [{ city: 'İstanbul', district: 'Çankaya' }],
    });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses an area whose neighbourhood belongs to another district', async () => {
    const foreign = listNeighborhoods('Ankara', 'Çankaya')[0];
    expect(foreign).toBeTruthy();

    const response = await postApplication({
      serviceAreas: [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: foreign }],
    });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses a neighbourhood given without a district', async () => {
    const response = await postApplication({
      serviceAreas: [{ city: 'İstanbul', neighborhood: 'Caferağa Mah' }],
    });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });
});

describe('PATCH /providers/:id', () => {
  it('applies the same check, and leaves the stored address untouched when it fails', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), city: 'İstanbul', district: 'Çankaya' })
      .expect(400);

    const unchanged = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: provider.id },
      select: { city: true, district: true },
    });
    expect(unchanged).toEqual({ city: 'İstanbul', district: 'Kadıköy' });
  });

  it('accepts a real pair and canonicalises it', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({
        ...providerPayload([category.id]),
        city: 'ankara',
        district: 'çankaya',
        serviceAreas: [{ city: 'ankara', district: 'çankaya' }],
      })
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: provider.id },
      select: { city: true, district: true },
    });
    expect(updated).toEqual({ city: 'Ankara', district: 'Çankaya' });
  });
});
