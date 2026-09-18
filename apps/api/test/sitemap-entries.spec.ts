import { ProviderStatus, ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INDEX_ELIGIBLE_SCOPE,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createProviderProfile,
  createShowcasePackage,
  createTestApp,
  createUser,
  indexEligibleText,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import { SEO_INDEX_THRESHOLDS } from '../src/modules/seo/seo-index-eligibility';

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

/**
 * A card on the air for `providerId`, or one whose run has ended. `eligible`
 * writes a summary and scope that clear the card rule; the default does not.
 */
async function seedCard(options: {
  providerId: string;
  categoryId: string;
  live: boolean;
  title: string;
  eligible?: boolean;
  summary?: string;
}) {
  const pkg = await createShowcasePackage(ctx.prisma);
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: options.providerId,
    categoryId: options.categoryId,
    title: options.title,
    areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    ...(options.eligible
      ? {
          summary: options.summary ?? indexEligibleText(SEO_INDEX_THRESHOLDS.showcaseSummaryMinChars, options.title),
          ...INDEX_ELIGIBLE_SCOPE,
        }
      : {}),
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

/** An approved, discoverable business whose profile clears the business rule. */
async function seedEligibleProvider(categoryId: string) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  return createDiscoverableProvider(ctx.prisma, {
    userId: owner.id,
    categoryId,
    description: indexEligibleText(SEO_INDEX_THRESHOLDS.providerDescriptionMinChars),
  });
}

describe('GET /sitemap/entries — what is listed', () => {
  it('lists no category today: an ACTIVE leaf is public, but no category carries the editorial blocks', async () => {
    const live = await createCategory(ctx.prisma, 'Canlı Hizmet');
    // Even a long description does not do it: the editorial blocks have no home yet (B4).
    await ctx.prisma.serviceCategory.update({
      where: { id: live.id },
      data: { description: indexEligibleText(SEO_INDEX_THRESHOLDS.categoryDescriptionMinChars) },
    });
    await createCategory(ctx.prisma, 'Taslak Hizmet', { status: ServiceCategoryStatus.DRAFT });
    await createCategory(ctx.prisma, 'Kapalı Hizmet', { status: ServiceCategoryStatus.INACTIVE });
    await createCategory(ctx.prisma, 'Grup', { kind: ServiceCategoryKind.GROUP });
    await createCategory(ctx.prisma, 'Yönlendirici', { kind: ServiceCategoryKind.ROUTER });

    const body = await entries();

    expect(body.categories).toEqual([]);
    // The page says the same: public, and not indexable.
    const page = await request(ctx.server).get(`/categories/${live.slug}`).expect(200);
    expect(page.body.seoIndexable).toBe(false);
  });

  it('lists index-eligible APPROVED businesses only, as id and updatedAt, ordered by id', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const a = await seedEligibleProvider(category.id);
    const b = await seedEligibleProvider(category.id);
    // Public, and not eligible: no description, a short one, no category, an
    // incomplete area, a DRAFT-only category.
    const noDescription = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, description: null });
    const short = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const noCategory = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.APPROVED,
      description: indexEligibleText(SEO_INDEX_THRESHOLDS.providerDescriptionMinChars),
    });
    const draft = await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    const draftOnly = await createDiscoverableProvider(ctx.prisma, {
      categoryId: draft.id,
      description: indexEligibleText(SEO_INDEX_THRESHOLDS.providerDescriptionMinChars),
    });
    const padded = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      description: `<b>kısa</b>${'&nbsp;'.repeat(400)}${' .'.repeat(400)}`,
    });
    for (const status of [
      ProviderStatus.DRAFT,
      ProviderStatus.PENDING_REVIEW,
      ProviderStatus.REJECTED,
      ProviderStatus.SUSPENDED,
    ]) {
      await createProviderProfile(ctx.prisma, {
        status,
        description: indexEligibleText(SEO_INDEX_THRESHOLDS.providerDescriptionMinChars),
      });
    }

    const body = await entries();

    expect(body.providers).toEqual(
      [a, b]
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .map((profile) => ({ id: profile.id, updatedAt: profile.updatedAt.toISOString() })),
    );

    // The page and the sitemap are one rule: listed ⇔ seoIndexable.
    for (const provider of [a, b]) {
      const page = await request(ctx.server).get(`/providers/${provider.id}`).expect(200);
      expect(page.body.seoIndexable, provider.id).toBe(true);
    }
    for (const provider of [noDescription, short, noCategory, draftOnly, padded]) {
      const page = await request(ctx.server).get(`/providers/${provider.id}`).expect(200);
      expect(page.body.seoIndexable, provider.id).toBe(false);
    }
  });

  it('lists the index-eligible cards the public feed serves, once each, and none the feed refuses', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const provider = await seedEligibleProvider(category.id);
    const live = await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'Yayında', eligible: true });
    const expired = await seedCard({ providerId: provider.id, categoryId: category.id, live: false, title: 'Bitti', eligible: true });
    // Public, and not eligible: the default short summary and two-item scope.
    const thin = await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'İnce' });
    // Two live cards of one business with the same summary: neither is its own page.
    const copyA = await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'Kopya A', eligible: true, summary: indexEligibleText(SEO_INDEX_THRESHOLDS.showcaseSummaryMinChars, 'aynı') });
    const copyB = await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'Kopya B', eligible: true, summary: `<p>${indexEligibleText(SEO_INDEX_THRESHOLDS.showcaseSummaryMinChars, 'AYNI')}</p>` });

    // A business that is public but not eligible takes its card with it.
    const thinOwner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const thinProvider = await createDiscoverableProvider(ctx.prisma, { userId: thinOwner.id, categoryId: category.id });
    const cardOfThinProvider = await seedCard({ providerId: thinProvider.id, categoryId: category.id, live: true, title: 'Sahibi ince', eligible: true });

    // A business that is no longer approved takes its live card off the air too.
    const suspendedOwner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const suspended = await createDiscoverableProvider(ctx.prisma, {
      userId: suspendedOwner.id,
      categoryId: category.id,
      description: indexEligibleText(SEO_INDEX_THRESHOLDS.providerDescriptionMinChars),
    });
    const suspendedCard = await seedCard({ providerId: suspended.id, categoryId: category.id, live: true, title: 'Askıda', eligible: true });
    await ctx.prisma.providerProfile.update({ where: { id: suspended.id }, data: { status: ProviderStatus.SUSPENDED } });

    const body = await entries();

    expect(body.showcaseCards).toEqual([{ cardId: live.id }]);
    for (const card of [expired, thin, copyA, copyB, cardOfThinProvider, suspendedCard]) {
      expect(body.showcaseCards.map((row) => row.cardId), card.id).not.toContain(card.id);
    }

    // The feed serves every public card; the sitemap lists the eligible one.
    const feed = await request(ctx.server).get('/showcase/feed?limit=48').expect(200);
    expect(feed.body.cards.map((card: { cardId: string }) => card.cardId).sort()).toEqual(
      [live.id, thin.id, copyA.id, copyB.id, cardOfThinProvider.id].sort(),
    );
    // Four public cards, one eligible: the shelf itself is not indexable.
    expect(feed.body.seoIndexable).toBe(false);
    await request(ctx.server).get(`/showcase/cards/${expired.id}`).expect(404);
    await request(ctx.server).get(`/showcase/cards/${suspendedCard.id}`).expect(404);
    // The page and the sitemap are one rule: listed ⇔ seoIndexable.
    expect((await request(ctx.server).get(`/showcase/cards/${live.id}`).expect(200)).body.seoIndexable).toBe(true);
    for (const card of [thin, copyA, copyB, cardOfThinProvider]) {
      const page = await request(ctx.server).get(`/showcase/cards/${card.id}`).expect(200);
      expect(page.body.seoIndexable, card.id).toBe(false);
    }
  });

  it('marks the shelf indexable once enough live cards are eligible, and not one card fewer', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const provider = await seedEligibleProvider(category.id);
    const needed = SEO_INDEX_THRESHOLDS.showcaseShelfMinIndexableCards;
    const cards: string[] = [];
    for (let index = 0; index < needed - 1; index += 1) {
      cards.push((await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: `Kart ${index}`, eligible: true })).id);
    }
    // Padding the shelf with public-but-thin cards changes nothing.
    await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'İnce 1' });
    await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'İnce 2' });

    expect((await request(ctx.server).get('/showcase/feed').expect(200)).body.seoIndexable).toBe(false);

    cards.push((await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: `Kart ${needed}`, eligible: true })).id);

    expect((await request(ctx.server).get('/showcase/feed').expect(200)).body.seoIndexable).toBe(true);
    // The same answer under a filter or a page size: the shelf's rule is not the page's.
    expect((await request(ctx.server).get('/showcase/feed?limit=1').expect(200)).body.seoIndexable).toBe(true);
    expect((await request(ctx.server).get('/showcase/feed?city=Ankara').expect(200)).body.seoIndexable).toBe(true);
    expect((await entries()).showcaseCards.map((row) => row.cardId).sort()).toEqual([...cards].sort());
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
    const provider = await seedEligibleProvider(category.id);
    await seedCard({ providerId: provider.id, categoryId: category.id, live: true, title: 'Gizli Başlık 1.500 ₺', eligible: true });

    const response = await request(ctx.server).get('/sitemap/entries').expect(200);
    const body = response.body as Entries;

    expect(Object.keys(body).sort()).toEqual(['categories', 'providers', 'showcaseCards']);
    expect(body.categories).toEqual([]);
    expect(Object.keys(body.providers[0]!).sort()).toEqual(['id', 'updatedAt']);
    expect(Object.keys(body.showcaseCards[0]!)).toEqual(['cardId']);
    // Nothing a page would print and nothing a person could be reached by —
    // and nothing the eligibility rule read on the way (the description, the
    // scope, the count) either.
    expect(response.text).not.toMatch(/İşletme|Yetkili|0555|example\.test|Kadıköy|Gizli Başlık|1500|moderasyon|Kapı no|Filtre|klima bakımı/);
  });

  it('answers the same body to a visitor, a customer, a provider and an operator', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const provider = await seedEligibleProvider(category.id);
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    const anonymous = await entries();
    expect(anonymous.providers.map((row) => row.id)).toEqual([provider.id]);

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
    const a = await seedEligibleProvider(category.id);
    const b = await seedEligibleProvider(category.id);
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });

    const plain = await entries();
    const asked = await request(ctx.server)
      .get('/sitemap/entries?includeInactive=true&limit=1&cursor=abc&q=x')
      .expect(200);
    expect(asked.body).toEqual(plain);
    expect(plain.providers.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
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
