import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createTestApp,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';
import {
  listNeighborhoods,
  listProvinces,
  resolveLocation,
} from '../src/modules/locations/turkey-locations';

/**
 * The province/district/neighbourhood relation, enforced on the server.
 *
 * The form offers dependent selects, so a customer cannot compose an impossible
 * address by hand. That is a convenience and not a guarantee: POST
 * /service-requests is public and takes plain JSON, so every case below posts
 * the body a tampered client would send rather than driving the form.
 *
 * Why it matters beyond tidiness: provider discovery matches a request's city
 * and district against a provider's service areas as text. A request stored at
 * "İstanbul / Çankaya" — two real names that are not one place — is a request no
 * provider can ever be shown.
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

/** A real neighbourhood of İstanbul / Kadıköy, read from the shipped dataset. */
function firstKadikoyNeighborhood(): string {
  const [name] = listNeighborhoods('İstanbul', 'Kadıköy');
  if (!name) throw new Error('The location dataset has no Kadıköy neighbourhood to test with.');
  return name;
}

describe('the shipped administrative dataset', () => {
  it('covers all 81 provinces and only relates districts to their own province', () => {
    const provinces = listProvinces();
    expect(provinces).toHaveLength(81);

    const istanbul = provinces.find((province) => province.name === 'İstanbul');
    expect(istanbul?.districts).toContain('Kadıköy');
    expect(istanbul?.districts).not.toContain('Çankaya');
  });

  it('canonicalises a differently cased or spaced name without inventing one', () => {
    expect(resolveLocation({ city: '  istanbul ', district: 'kadıköy' })).toEqual({
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: null,
    });

    // A keyboard without a Turkish layout: "Istanbul" lowercases to "ıstanbul".
    expect(resolveLocation({ city: 'Istanbul', district: 'Kadikoy' })).toBeNull();
    expect(resolveLocation({ city: 'Istanbul', district: 'Kadıköy' })?.city).toBe('İstanbul');

    expect(resolveLocation({ city: 'Vatikan', district: 'Kadıköy' })).toBeNull();
  });
});

describe('POST /service-requests location validation', () => {
  async function postRequest(overrides: Record<string, unknown>) {
    const category = await createCategory(ctx.prisma);
    return request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, overrides));
  }

  it('accepts a real province and district and stores the canonical spelling', async () => {
    const response = await postRequest({ city: 'istanbul', district: 'kadıköy' });

    expect(response.status).toBe(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: response.body.id as string },
      select: { city: true, district: true, neighborhood: true },
    });
    expect(stored).toEqual({ city: 'İstanbul', district: 'Kadıköy', neighborhood: null });
  });

  it('accepts a neighbourhood of that district and stores it canonically', async () => {
    const neighborhood = firstKadikoyNeighborhood();
    const response = await postRequest({
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: neighborhood.toLocaleLowerCase('tr-TR'),
    });

    expect(response.status).toBe(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: response.body.id as string },
      select: { neighborhood: true },
    });
    expect(stored.neighborhood).toBe(neighborhood);
  });

  it('refuses a district that belongs to a different province', async () => {
    const response = await postRequest({ city: 'İstanbul', district: 'Çankaya' });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses a province that does not exist', async () => {
    const response = await postRequest({ city: 'Kadıköy', district: 'Kadıköy' });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses an invented district in a real province', async () => {
    // The shape the E2E fixtures used to build: unique, but not a place.
    const response = await postRequest({ city: 'İstanbul', district: 'Kadıköy-7f3a11' });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses a neighbourhood that belongs to another district', async () => {
    const foreign = listNeighborhoods('Ankara', 'Çankaya')[0];
    expect(foreign).toBeTruthy();

    const response = await postRequest({
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: foreign,
    });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('still treats the neighbourhood as optional', async () => {
    const response = await postRequest({ city: 'Ankara', district: 'Çankaya', neighborhood: null });

    expect(response.status).toBe(201);
  });
});

describe('GET /locations', () => {
  it('serves the provinces with their districts', async () => {
    const response = await request(ctx.server).get('/locations/provinces');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(81);
    const istanbul = (response.body as Array<{ name: string; districts: string[] }>).find(
      (province) => province.name === 'İstanbul',
    );
    expect(istanbul?.districts).toContain('Kadıköy');
  });

  it("serves a district's neighbourhoods and answers an unknown pair with an empty list", async () => {
    const known = await request(ctx.server)
      .get('/locations/neighborhoods')
      .query({ city: 'İstanbul', district: 'Kadıköy' });
    expect(known.status).toBe(200);
    expect(known.body).toContain(firstKadikoyNeighborhood());

    const unknown = await request(ctx.server)
      .get('/locations/neighborhoods')
      .query({ city: 'İstanbul', district: 'Çankaya' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual([]);
  });
});

describe('existing request data', () => {
  it('is unaffected: a request seeded directly still reads back as it was written', async () => {
    const category = await createCategory(ctx.prisma);
    const seeded = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: seeded.id },
      select: { city: true, district: true },
    });
    expect(stored.city).toBe('İstanbul');
    expect(stored.district).toBe('Kadıköy');
  });
});
