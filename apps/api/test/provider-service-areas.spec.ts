import { Prisma, ProviderServiceAreaScope, UserRole } from '@prisma/client';
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
  serviceAreaRow,
  type TestContext,
} from './harness';

/**
 * A provider's coverage: many areas, three scopes, and the two ways a list of
 * them can be wrong.
 *
 * The form offers dependent selects and refuses these combinations before it
 * posts. That is a convenience and nothing more — POST /providers takes a plain
 * JSON body, so everything below sends what a tampered client would, and the
 * last block sends what no client can reach at all by writing straight to the
 * table.
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

async function postApplication(serviceAreas: unknown) {
  const category = await createCategory(ctx.prisma);
  return request(ctx.server)
    .post('/providers')
    .send({ ...providerPayload([category.id]), serviceAreas });
}

async function storedAreas(providerId: string) {
  return ctx.prisma.providerServiceArea.findMany({
    where: { providerId },
    orderBy: [{ city: 'asc' }, { district: 'asc' }, { neighborhood: 'asc' }],
    select: { scope: true, city: true, district: true, neighborhood: true },
  });
}

describe('POST /providers — many areas at three scopes', () => {
  it('stores one row per area with the scope its levels imply', async () => {
    const response = await postApplication([
      { city: 'istanbul' },
      { city: 'Ankara', district: 'çankaya' },
      { city: 'Bursa', district: 'Nilüfer', neighborhood: 'Ertuğrul Mah' },
    ]);

    expect(response.status).toBe(201);
    expect(await storedAreas(response.body.id as string)).toEqual([
      {
        scope: ProviderServiceAreaScope.DISTRICT,
        city: 'Ankara',
        district: 'Çankaya',
        neighborhood: null,
      },
      {
        scope: ProviderServiceAreaScope.NEIGHBORHOOD,
        city: 'Bursa',
        district: 'Nilüfer',
        neighborhood: 'Ertuğrul Mah',
      },
      {
        scope: ProviderServiceAreaScope.CITY,
        city: 'İstanbul',
        district: null,
        neighborhood: null,
      },
    ]);
  });

  it('lets two whole provinces sit beside each other', async () => {
    const response = await postApplication([{ city: 'İstanbul' }, { city: 'Ankara' }]);

    expect(response.status).toBe(201);
    expect(await storedAreas(response.body.id as string)).toHaveLength(2);
  });

  it('lets two districts of one province sit beside each other', async () => {
    const response = await postApplication([
      { city: 'İstanbul', district: 'Kadıköy' },
      { city: 'İstanbul', district: 'Beşiktaş' },
    ]);

    expect(response.status).toBe(201);
    expect(await storedAreas(response.body.id as string)).toHaveLength(2);
  });

  it('never takes a scope from the client', async () => {
    // The DTO has no `scope` field, so the global ValidationPipe refuses a body
    // that invents one. The column is the server's to decide, and this is what
    // stops a client claiming CITY reach while naming a single district.
    const response = await postApplication([
      { city: 'İstanbul', district: 'Kadıköy', scope: 'CITY' },
    ]);

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });
});

describe('POST /providers — the refusals', () => {
  it('refuses an empty list', async () => {
    const response = await postApplication([]);

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('En az bir hizmet bölgesi');
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses the same area twice, however it was spelled', async () => {
    const response = await postApplication([
      { city: 'İstanbul', district: 'Kadıköy' },
      { city: 'istanbul', district: 'KADIKÖY' },
    ]);

    expect(response.status).toBe(400);
    // The whole sentence, so the label the message is built from is pinned too:
    // it is the same scope wording the profile, the admin screens and the
    // provider's own e-mail print.
    expect(response.body.message).toBe(
      'Aynı hizmet bölgesini iki kez ekleyemezsiniz: Kadıköy, İstanbul.',
    );
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses a district under a province the same list already covers whole', async () => {
    const response = await postApplication([
      { city: 'İstanbul' },
      { city: 'İstanbul', district: 'Kadıköy' },
    ]);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(
      'İstanbul geneli zaten Kadıköy, İstanbul bölgesini kapsıyor. İkisini birlikte ekleyemezsiniz.',
    );
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses it in the other order too', async () => {
    const response = await postApplication([
      { city: 'İstanbul', district: 'Kadıköy' },
      { city: 'İstanbul' },
    ]);

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses a neighbourhood under a district the same list already covers whole', async () => {
    const response = await postApplication([
      { city: 'İstanbul', district: 'Kadıköy' },
      { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
    ]);

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses a neighbourhood that was typed rather than chosen', async () => {
    // The form has no free-text neighbourhood any more. This is the guarantee
    // behind that: matching compares these as plain text, so "Moda" — which is
    // not how the postal list spells any Kadıköy neighbourhood — would be an
    // area that silently matches nothing at all.
    const response = await postApplication([
      { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Moda' },
    ]);

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('keeps every area out when one of them is invalid', async () => {
    const response = await postApplication([
      { city: 'İstanbul', district: 'Kadıköy' },
      { city: 'İstanbul', district: 'Çankaya' },
    ]);

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
    expect(await ctx.prisma.providerServiceArea.count()).toBe(0);
  });
});

describe('PATCH /providers/:id — replacing the coverage', () => {
  async function adminCookie() {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    return loginAs(ctx.prisma, admin.id);
  }

  it('adds areas and drops the ones that were left out', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }) },
    });
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({
        ...providerPayload([category.id]),
        serviceAreas: [
          { city: 'Ankara' },
          { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
        ],
      })
      .expect(200);

    expect(await storedAreas(provider.id)).toEqual([
      {
        scope: ProviderServiceAreaScope.CITY,
        city: 'Ankara',
        district: null,
        neighborhood: null,
      },
      {
        scope: ProviderServiceAreaScope.NEIGHBORHOOD,
        city: 'İstanbul',
        district: 'Kadıköy',
        neighborhood: 'Caferağa Mah',
      },
    ]);
  });

  it('leaves the stored coverage untouched when the new list is refused', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }) },
    });
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({
        ...providerPayload([category.id]),
        serviceAreas: [{ city: 'İstanbul' }, { city: 'İstanbul', district: 'Kadıköy' }],
      })
      .expect(400);

    expect(await storedAreas(provider.id)).toEqual([
      {
        scope: ProviderServiceAreaScope.DISTRICT,
        city: 'İstanbul',
        district: 'Kadıköy',
        neighborhood: null,
      },
    ]);
  });

  it('saves a stored overlapping pair back unchanged', async () => {
    // The pair the migration deliberately did not collapse. Its owner has to be
    // able to open this form, change something else, and save — so an overlap
    // that was already on file is not what the save is refused for.
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    await ctx.prisma.providerServiceArea.createMany({
      data: [
        { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul' }) },
        { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }) },
      ],
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({
        ...providerPayload([category.id]),
        businessName: 'Yeni Ad',
        serviceAreas: [{ city: 'İstanbul' }, { city: 'İstanbul', district: 'Kadıköy' }],
      })
      .expect(200);

    // District first: the ordering is city, district, neighbourhood ascending,
    // and PostgreSQL sorts the province-wide row's NULL district last.
    expect(await storedAreas(provider.id)).toEqual([
      {
        scope: ProviderServiceAreaScope.DISTRICT,
        city: 'İstanbul',
        district: 'Kadıköy',
        neighborhood: null,
      },
      {
        scope: ProviderServiceAreaScope.CITY,
        city: 'İstanbul',
        district: null,
        neighborhood: null,
      },
    ]);
  });

  it('lets one half of a stored overlap be removed', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    await ctx.prisma.providerServiceArea.createMany({
      data: [
        { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul' }) },
        { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }) },
      ],
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), serviceAreas: [{ city: 'İstanbul' }] })
      .expect(200);

    expect(await storedAreas(provider.id)).toEqual([
      {
        scope: ProviderServiceAreaScope.CITY,
        city: 'İstanbul',
        district: null,
        neighborhood: null,
      },
    ]);
  });

  it('still refuses a new overlap over an area that was already stored', async () => {
    // Grandfathering covers the pair that was on file, and only that pair. A
    // third area under the same province is one this save is introducing, so
    // the rule applies to it in full.
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    await ctx.prisma.providerServiceArea.createMany({
      data: [
        { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul' }) },
        { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }) },
      ],
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({
        ...providerPayload([category.id]),
        serviceAreas: [
          { city: 'İstanbul' },
          { city: 'İstanbul', district: 'Kadıköy' },
          { city: 'İstanbul', district: 'Beşiktaş' },
        ],
      })
      .expect(400);

    expect(response.body.message).toBe(
      'İstanbul geneli zaten Beşiktaş, İstanbul bölgesini kapsıyor. İkisini birlikte ekleyemezsiniz.',
    );
    expect(await storedAreas(provider.id)).toHaveLength(2);
  });

  it('grandfathers nothing into a brand new application', async () => {
    const response = await postApplication([
      { city: 'İstanbul' },
      { city: 'İstanbul', district: 'Kadıköy' },
    ]);

    expect(response.status).toBe(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('returns the areas with their scope, so a screen can label them', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: provider.id, ...serviceAreaRow({ city: 'İstanbul' }) },
    });
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.serviceAreas).toEqual([
      expect.objectContaining({
        scope: 'CITY',
        city: 'İstanbul',
        district: null,
        neighborhood: null,
      }),
    ]);
  });
});

/**
 * The database's own guarantees, written to directly.
 *
 * Everything above goes through the endpoint, which is where a well-behaved
 * writer is stopped. These four cases are what a badly-behaved one — a retry, a
 * future import script, a hand-run UPDATE — runs into instead.
 */
describe('ProviderServiceArea constraints', () => {
  async function providerId() {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    return provider.id;
  }

  it('refuses a second province-wide row for one provider', async () => {
    const id = await providerId();
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: id, ...serviceAreaRow({ city: 'İstanbul' }) },
    });

    await expect(
      ctx.prisma.providerServiceArea.create({
        data: { providerId: id, ...serviceAreaRow({ city: 'İstanbul' }) },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await ctx.prisma.providerServiceArea.count({ where: { providerId: id } })).toBe(1);
  });

  it('refuses a second district row for one provider', async () => {
    const id = await providerId();
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: id, ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }) },
    });

    await expect(
      ctx.prisma.providerServiceArea.create({
        data: { providerId: id, ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }) },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('refuses a second neighbourhood row for one provider', async () => {
    const id = await providerId();
    const area = serviceAreaRow({
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: 'Caferağa Mah',
    });
    await ctx.prisma.providerServiceArea.create({ data: { providerId: id, ...area } });

    await expect(
      ctx.prisma.providerServiceArea.create({ data: { providerId: id, ...area } }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('lets two providers hold the same area', async () => {
    const first = await providerId();
    const second = await providerId();
    const area = serviceAreaRow({ city: 'İstanbul' });

    await ctx.prisma.providerServiceArea.create({ data: { providerId: first, ...area } });
    await ctx.prisma.providerServiceArea.create({ data: { providerId: second, ...area } });

    expect(await ctx.prisma.providerServiceArea.count()).toBe(2);
  });

  it('carries the three partial unique indexes and the scope CHECK the migration created', async () => {
    // Prisma cannot express either in the schema, so both live in raw SQL —
    // which means nothing regenerates them and nothing notices if a later
    // migration drops one. This reads them back from the catalogue.
    const indexes = await ctx.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'ProviderServiceArea' AND indexname LIKE 'ProviderServiceArea_one_%'
      ORDER BY indexname
    `;

    expect(indexes.map((index) => index.indexname)).toEqual([
      'ProviderServiceArea_one_city_area',
      'ProviderServiceArea_one_district_area',
      'ProviderServiceArea_one_neighborhood_area',
    ]);
    for (const index of indexes) {
      expect(index.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index.indexdef).toContain('WHERE (scope =');
    }

    const checks = await ctx.prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"ProviderServiceArea"'::regclass AND contype = 'c'
    `;
    expect(checks.map((check) => check.conname)).toContain('ProviderServiceArea_scope_levels');
  });

  it('leaves no provider without coverage, which is what the backfill guarantees', async () => {
    // The migration copies a provider's legacy single location into an area row
    // when it has none, so "at least one area" is true of stored rows and not
    // only of what the endpoint accepts. Nothing the API can be asked to do
    // reintroduces a coverage-less provider: a save with an empty list is
    // refused before the delete-and-recreate runs.
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    await ctx.prisma.providerServiceArea.create({
      data: {
        providerId: provider.id,
        ...serviceAreaRow({ city: 'İstanbul', district: 'Kadıköy' }),
      },
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), serviceAreas: [] })
      .expect(400);

    expect(
      await ctx.prisma.providerServiceArea.count({ where: { providerId: provider.id } }),
    ).toBe(1);
  });

  it('refuses a scope that disagrees with the levels beside it', async () => {
    const id = await providerId();

    // A CHECK violation reaches Prisma without an error code, so these assert
    // on the constraint by name — the fact worth pinning anyway, because it
    // says which rule refused the row.
    //
    // CITY reach while naming a district: exactly the row that would make the
    // province-wide unique index a lie.
    await expect(
      ctx.prisma.providerServiceArea.create({
        data: {
          providerId: id,
          scope: ProviderServiceAreaScope.CITY,
          city: 'İstanbul',
          district: 'Kadıköy',
          neighborhood: null,
        },
      }),
    ).rejects.toThrow(/ProviderServiceArea_scope_levels/);

    // And a neighbourhood floating under a whole province, which names no place.
    await expect(
      ctx.prisma.providerServiceArea.create({
        data: {
          providerId: id,
          scope: ProviderServiceAreaScope.NEIGHBORHOOD,
          city: 'İstanbul',
          district: null,
          neighborhood: 'Caferağa Mah',
        },
      }),
    ).rejects.toThrow(/ProviderServiceArea_scope_levels/);

    expect(await ctx.prisma.providerServiceArea.count()).toBe(0);
  });
});
