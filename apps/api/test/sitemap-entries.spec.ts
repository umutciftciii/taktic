import { ProviderStatus, ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createProviderProfile,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * `GET /sitemap/entries` — the one thing the web's sitemap.xml reads.
 *
 * It answers exactly the question a sitemap has — which public records exist
 * right now — and nothing else: category slugs, approved business ids and the
 * ids of cards on the air, each with the row's own `updatedAt` where one is
 * meaningful. It is not a directory: no name, no city, no contact detail, no
 * price, no note travels here, because the page behind each id is where those
 * are read from, under that page's own public projection. The three
 * visibility rules are the ones the public pages already apply, so an id
 * listed here is an id `/categories/:slug`, `/isletme/:id` and
 * `/vitrin/:cardId` answer 200 for.
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

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

type Entries = {
  categories: { slug: string; updatedAt: string }[];
  providers: { id: string; updatedAt: string }[];
  showcaseCards: { cardId: string }[];
};

async function entries(): Promise<Entries> {
  const response = await request(ctx.server).get('/sitemap/entries').expect(200);
  return response.body as Entries;
}

/** A card on the air for `providerId`, or one whose run has ended. */
async function seedCard(options: { providerId: string; categoryId: string; live: boolean; title: string }) {
  const pkg = await createShowcasePackage(ctx.prisma);
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: options.providerId,
    categoryId: options.categoryId,
    title: options.title,
    areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
  });
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: options.providerId,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });
  if (!options.live) {
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { status: 'EXPIRED', endAt: new Date(placement.startAt.getTime() + 1000) },
    });
  }
  return card;
}

describe('GET /sitemap/entries — what is listed', () => {
  it('lists ACTIVE leaf categories only, as slug and updatedAt', async () => {
    const live = await createCategory(ctx.prisma, 'Canlı Hizmet');
    await createCategory(ctx.prisma, 'Taslak Hizmet', { status: ServiceCategoryStatus.DRAFT });
    await createCategory(ctx.prisma, 'Kapalı Hizmet', { status: ServiceCategoryStatus.INACTIVE });
    await createCategory(ctx.prisma, 'Grup', { kind: ServiceCategoryKind.GROUP });
    await createCategory(ctx.prisma, 'Yönlendirici', { kind: ServiceCategoryKind.ROUTER });

    const body = await entries();

    expect(body.categories).toEqual([{ slug: live.slug, updatedAt: live.updatedAt.toISOString() }]);
  });

  it('lists APPROVED businesses only, as id and updatedAt, ordered by id', async () => {
    const a = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const b = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    for (const status of [
      ProviderStatus.DRAFT,
      ProviderStatus.PENDING_REVIEW,
      ProviderStatus.REJECTED,
      ProviderStatus.SUSPENDED,
    ]) {
      await createProviderProfile(ctx.prisma, { status });
    }

    const body = await entries();

    expect(body.providers).toEqual(
      [a, b]
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .map((profile) => ({ id: profile.id, updatedAt: profile.updatedAt.toISOString() })),
    );
  });

  it('lists the cards the public feed serves, once each, and none the feed refuses', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    const live = await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'Yayında' });
    const expired = await seedCard({ providerId: provider.id, categoryId: category.id, live: false, title: 'Bitti' });

    // A business that is no longer approved takes its live card off the air too.
    const suspendedOwner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const suspended = await createDiscoverableProvider(ctx.prisma, { userId: suspendedOwner.id, categoryId: category.id });
    const suspendedCard = await seedCard({ providerId: suspended.id, categoryId: category.id, live: true, title: 'Askıda' });
    await ctx.prisma.providerProfile.update({ where: { id: suspended.id }, data: { status: ProviderStatus.SUSPENDED } });

    const body = await entries();

    expect(body.showcaseCards).toEqual([{ cardId: live.id }]);
    expect(body.showcaseCards.map((row) => row.cardId)).not.toContain(expired.id);
    expect(body.showcaseCards.map((row) => row.cardId)).not.toContain(suspendedCard.id);

    // Same answer as the feed itself: every listed id is served, every other is not.
    const feed = await request(ctx.server).get('/showcase/feed?limit=48').expect(200);
    expect(feed.body.cards.map((card: { cardId: string }) => card.cardId).sort()).toEqual([live.id]);
    await request(ctx.server).get(`/showcase/cards/${expired.id}`).expect(404);
    await request(ctx.server).get(`/showcase/cards/${suspendedCard.id}`).expect(404);
    await request(ctx.server).get(`/showcase/cards/${live.id}`).expect(200);
  });

  it('is empty rather than an error with nothing public', async () => {
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    expect(await entries()).toEqual({ categories: [], providers: [], showcaseCards: [] });
  });
});

describe('GET /sitemap/entries — what never travels', () => {
  it('carries exactly the sitemap fields and no business content', async () => {
    const category = await createCategory(ctx.prisma, 'Klima Bakımı');
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'Gizli Başlık 1.500 ₺' });

    const response = await request(ctx.server).get('/sitemap/entries').expect(200);
    const body = response.body as Entries;

    expect(Object.keys(body).sort()).toEqual(['categories', 'providers', 'showcaseCards']);
    expect(Object.keys(body.categories[0]!).sort()).toEqual(['slug', 'updatedAt']);
    expect(Object.keys(body.providers[0]!).sort()).toEqual(['id', 'updatedAt']);
    expect(Object.keys(body.showcaseCards[0]!)).toEqual(['cardId']);
    // Nothing a page would print and nothing a person could be reached by.
    expect(response.text).not.toMatch(/İşletme|Yetkili|0555|example\.test|Kadıköy|Gizli Başlık|1500|moderasyon|Kapı no/);
  });

  it('answers the same body to a visitor, a customer, a provider and an operator', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    const anonymous = await entries();
    expect(anonymous.categories.map((row) => row.slug)).toEqual([category.slug]);

    for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER, UserRole.SUPER_ADMIN]) {
      const user = await createUser(ctx.prisma, { role });
      const cookie = await loginAs(ctx.prisma, user.id);
      const response = await request(ctx.server)
        .get('/sitemap/entries')
        .set('Cookie', `${COOKIE_NAME}=${cookie}`)
        .expect(200);
      expect(response.body, role).toEqual(anonymous);
    }
  });

  it('is not cached by anything on the way', async () => {
    const response = await request(ctx.server).get('/sitemap/entries').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('ignores a query string: no filter, no page, no view can be asked for', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });

    const plain = await entries();
    const asked = await request(ctx.server)
      .get('/sitemap/entries?includeInactive=true&limit=1&cursor=abc&q=x')
      .expect(200);
    expect(asked.body).toEqual(plain);
    expect(plain.categories.map((row) => row.slug)).toEqual([category.slug]);
  });
});

describe('GET /sitemap/entries — read-only', () => {
  it.each(['post', 'put', 'patch', 'delete'] as const)('%s is not a route', async (method) => {
    await request(ctx.server)[method]('/sitemap/entries').send({}).expect(404);
  });

  it('serves nothing else under /sitemap', async () => {
    await request(ctx.server).get('/sitemap').expect(404);
    await request(ctx.server).get('/sitemap/providers').expect(404);
    await request(ctx.server).get('/providers/public-directory').expect(404);
  });
});
