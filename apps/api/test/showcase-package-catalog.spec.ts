import { Prisma, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createDiscoverableProvider,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * The vitrin catalogue, and the one rule that is not about the catalogue at
 * all.
 *
 * `ShowcasePackage.slug` must begin with `vitrin-` and `OfferCreditPackage.slug`
 * must not, and both are CHECK constraints rather than application rules. What
 * they prevent is not a data problem: `LEMON_SQUEEZY_VARIANT_MAP` is keyed by
 * slug and spans both catalogues, so without a reserved namespace one map entry
 * could stand for a credit package and a vitrin package at once — a
 * configuration mistake no code path could see, and one that would settle a
 * payment against the wrong product.
 *
 * That is why these cases go at the database rather than only at the endpoint:
 * an endpoint can be bypassed by a seed script, a migration or a console.
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

async function admin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, user.id);
}

async function provider() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
  });

  return { category, profile, cookie: await loginAs(ctx.prisma, user.id) };
}

describe('the vitrin slug namespace', () => {
  it('refuses a vitrin package whose slug does not carry the prefix, at the database', async () => {
    await expect(
      ctx.prisma.showcasePackage.create({
        data: {
          name: 'Kaçak paket',
          slug: `standart-${uniqueSuffix()}`,
          priceAmount: 49_900,
          durationDays: 30,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses an offer package that reaches into the vitrin namespace', async () => {
    await expect(
      ctx.prisma.offerCreditPackage.create({
        data: {
          name: 'Kılık değiştirmiş paket',
          slug: `vitrin-${uniqueSuffix()}`,
          creditAmount: 10,
          priceAmount: 10_000,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses the prefix through the admin endpoint with a code the screen can read', async () => {
    const cookie = await admin();

    const response = await request(ctx.server)
      .post('/admin/showcase/packages')
      .set('Cookie', cookie)
      .send({
        name: 'Kaçak paket',
        slug: 'standart-30',
        priceAmount: 49_900,
        durationDays: 30,
      });

    expect(response.status).toBe(400);
  });

  it('accepts a prefixed slug', async () => {
    const cookie = await admin();

    const response = await request(ctx.server)
      .post('/admin/showcase/packages')
      .set('Cookie', cookie)
      .send({
        name: 'Vitrin Standart',
        slug: 'vitrin-standart-30',
        priceAmount: 49_900,
        durationDays: 30,
      });

    expect(response.status).toBe(201);
    expect(response.body.slug).toBe('vitrin-standart-30');
    // `requiresAdminApproval` ships false: a placement needs no second review,
    // because the card's text is already approved. The column exists so
    // deciding otherwise later is a controller change rather than a migration.
    expect(response.body.requiresAdminApproval).toBe(false);
  });
});

describe('catalogue bounds', () => {
  it.each([
    ['a price of zero', { priceAmount: 0 }],
    ['a duration of zero days', { durationDays: 0 }],
    ['a duration beyond a year', { durationDays: 400 }],
  ])('refuses %s at the database', async (_label, patch) => {
    await expect(
      ctx.prisma.showcasePackage.create({
        data: {
          name: 'Sınır dışı',
          slug: `vitrin-${uniqueSuffix()}`,
          priceAmount: 49_900,
          durationDays: 30,
          ...patch,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a second package on the same slug', async () => {
    const first = await createShowcasePackage(ctx.prisma);

    await expect(
      ctx.prisma.showcasePackage.create({
        data: {
          name: 'İkinci',
          slug: first.slug,
          priceAmount: 1_000,
          durationDays: 7,
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

describe('who may read and write the catalogue', () => {
  it('lets an operator list every package, retired ones included', async () => {
    const cookie = await admin();
    await createShowcasePackage(ctx.prisma, { isActive: false });

    const response = await request(ctx.server)
      .get('/admin/showcase/packages')
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.packages).toHaveLength(1);
    expect(response.body.packages[0].isActive).toBe(false);
  });

  it("hides retired packages from a provider's buying screen", async () => {
    const { profile, cookie } = await provider();
    await createShowcasePackage(ctx.prisma, { isActive: false });
    const live = await createShowcasePackage(ctx.prisma);

    const response = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/packages`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.packages.map((pkg: { id: string }) => pkg.id)).toEqual([live.id]);
  });

  it('narrows the buying screen to packages sold for this card kind', async () => {
    const { profile, cookie } = await provider();
    const serviceOnly = await createShowcasePackage(ctx.prisma, { allowedCardKind: 'SERVICE' });
    const promotionOnly = await createShowcasePackage(ctx.prisma, {
      allowedCardKind: 'PROMOTION',
    });
    const either = await createShowcasePackage(ctx.prisma);

    const response = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/packages?cardKind=SERVICE`)
      .set('Cookie', cookie);

    const ids = response.body.packages.map((pkg: { id: string }) => pkg.id);
    expect(ids).toContain(serviceOnly.id);
    expect(ids).toContain(either.id);
    expect(ids).not.toContain(promotionOnly.id);
  });

  it('refuses a provider on the admin catalogue', async () => {
    const { cookie } = await provider();

    const response = await request(ctx.server)
      .get('/admin/showcase/packages')
      .set('Cookie', cookie);

    expect(response.status).toBe(403);
  });

  it('refuses an anonymous caller on the admin catalogue', async () => {
    const response = await request(ctx.server).get('/admin/showcase/packages');
    expect(response.status).toBe(401);
  });
});

describe('editing a package', () => {
  it('changes price and duration without touching the slug', async () => {
    const cookie = await admin();
    const pkg = await createShowcasePackage(ctx.prisma, { priceAmount: 49_900, durationDays: 30 });

    const response = await request(ctx.server)
      .patch(`/admin/showcase/packages/${pkg.id}`)
      .set('Cookie', cookie)
      .send({ priceAmount: 79_900, durationDays: 60 });

    expect(response.status).toBe(200);
    expect(response.body.priceAmount).toBe(79_900);
    expect(response.body.durationDays).toBe(60);
    expect(response.body.slug).toBe(pkg.slug);
  });

  it('refuses a slug in the edit body rather than silently ignoring it', async () => {
    const cookie = await admin();
    const pkg = await createShowcasePackage(ctx.prisma);

    // `forbidNonWhitelisted` is what makes this a refusal. Silently dropping the
    // field would let a client believe it had renamed a package — and the
    // rename is the one edit that would break every future checkout for it.
    const response = await request(ctx.server)
      .patch(`/admin/showcase/packages/${pkg.id}`)
      .set('Cookie', cookie)
      .send({ slug: 'vitrin-yeni-ad' });

    expect(response.status).toBe(400);
  });
});
