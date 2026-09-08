import { ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  showcaseCardPayload,
  showcaseUpdatePayload,
  type TestContext,
} from './harness';
import { showcaseAreaKey } from '../src/common/showcase-area-key';

/**
 * What a provider may put on a vitrin card, and what the API refuses.
 *
 * Two rules carry most of this file, and both exist because a card is a public
 * claim a business makes about itself:
 *
 * - **A SERVICE card must carry a price and a PROMOTION card must not.** Both
 *   halves, because only one would leave the other representable: a priced
 *   promotion is a fixed-price claim the product says that card does not make.
 * - **A card may not claim reach the business has not claimed.** Every area is
 *   checked against the provider's own `ProviderServiceArea` rows with the same
 *   containment test their profile form uses.
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

async function providerFixture(options: {
  areas?: Array<{ city: string; district?: string | null; neighborhood?: string | null }>;
  categoryKind?: ServiceCategoryKind;
  categoryStatus?: ServiceCategoryStatus;
} = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', {
    kind: options.categoryKind ?? ServiceCategoryKind.LEAF,
    status: options.categoryStatus ?? ServiceCategoryStatus.ACTIVE,
  });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: options.areas ?? [{ city: 'İstanbul', district: 'Kadıköy' }],
  });
  const cookie = await loginAs(ctx.prisma, user.id);

  return { category, user, provider, cookie };
}

describe('vitrin kartı oluşturma', () => {
  it('bir SERVICE kartını taslak sürümüyle birlikte açar', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id))
      .expect(201);

    expect(response.body.status).toBe('DRAFT');
    expect(response.body.kind).toBe('SERVICE');
    expect(response.body.liveVersion).toBeNull();
    expect(response.body.draftVersion.versionNumber).toBe(1);
    expect(response.body.draftVersion.reviewStatus).toBe('DRAFT');
    // No acceptance is on file for a draft nobody has submitted. Recording one
    // here would be recording a consent that was never given.
    expect(response.body.draftVersion.priceTermsVersion).toBeNull();
    expect(response.body.draftVersion.priceTermsAcceptedAt).toBeNull();
    expect(response.body.draftVersion.submittedAt).toBeNull();
  });

  it('SERVICE kartını fiyatsız kabul etmez', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { listedServicePriceAmount: null }))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_INVALID');
  });

  it('PROMOTION kartına sabit fiyat yazılmasını kabul etmez', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          kind: 'PROMOTION',
          listedServicePriceAmount: 150000,
        }),
      )
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_INVALID');
  });

  it('PROMOTION kartını fiyatsız açar', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          kind: 'PROMOTION',
          listedServicePriceAmount: null,
        }),
      )
      .expect(201);

    expect(response.body.kind).toBe('PROMOTION');
    expect(response.body.draftVersion.listedServicePriceAmount).toBeNull();
  });

  it('sıfır ve negatif fiyatı DTO seviyesinde reddeder', async () => {
    const { category, provider, cookie } = await providerFixture();

    for (const amount of [0, -1]) {
      await request(ctx.server)
        .post(`/providers/${provider.id}/showcase/cards`)
        .set('Cookie', cookie)
        .send(showcaseCardPayload(category.id, { listedServicePriceAmount: amount }))
        .expect(400);
    }
  });

  it('boş kapsam listesini reddeder', async () => {
    const { category, provider, cookie } = await providerFixture();

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { scopeExcluded: [] }))
      .expect(400);

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { scopeIncluded: [] }))
      .expect(400);
  });

  it('acil yanıt süresini normalden uzun kabul etmez', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          responseSlaUrgentHours: 24,
          responseSlaNormalHours: 2,
        }),
      )
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_INVALID');
  });

  it('SLA sınırlarının dışındaki değerleri reddeder', async () => {
    const { category, provider, cookie } = await providerFixture();

    // 25 saat acil, 73 saat normal: ikisi de ürünün taahhüt aralığının dışında.
    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { responseSlaUrgentHours: 25 }))
      .expect(400);

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { responseSlaNormalHours: 73 }))
      .expect(400);
  });
});

describe('vitrin kartı kategorisi', () => {
  it('SERVICE kartını GROUP kategoriye bağlamayı reddeder', async () => {
    const { category, provider, cookie } = await providerFixture({
      categoryKind: ServiceCategoryKind.GROUP,
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_INVALID');
  });

  it('PROMOTION kartını GROUP kategoriye bağlar', async () => {
    const { category, provider, cookie } = await providerFixture({
      categoryKind: ServiceCategoryKind.GROUP,
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, { kind: 'PROMOTION', listedServicePriceAmount: null }),
      )
      .expect(201);
  });

  it('ROUTER kategorisini her iki tür için de reddeder', async () => {
    const { category, provider, cookie } = await providerFixture({
      categoryKind: ServiceCategoryKind.ROUTER,
    });

    for (const body of [
      showcaseCardPayload(category.id),
      showcaseCardPayload(category.id, { kind: 'PROMOTION', listedServicePriceAmount: null }),
    ]) {
      const response = await request(ctx.server)
        .post(`/providers/${provider.id}/showcase/cards`)
        .set('Cookie', cookie)
        .send(body)
        .expect(400);

      expect(response.body.code).toBe('SHOWCASE_CATEGORY_INVALID');
    }
  });

  it('DRAFT kategoriyi reddeder — yayınlanmamış katalog sızmaz', async () => {
    const { category, provider, cookie } = await providerFixture({
      categoryStatus: ServiceCategoryStatus.DRAFT,
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_INVALID');
  });
});

describe('vitrin kartı bölgeleri', () => {
  it('areaKey ve scope sunucuda türetilir; istemcinin gönderdiği yok sayılır', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          // Küçük harfli yazım: kanonik hâline çözümlenmeli.
          areas: [{ city: 'istanbul', district: 'kadıköy' }],
        }),
      )
      .expect(201);

    const [area] = response.body.draftVersion.areas;
    expect(area.city).toBe('İstanbul');
    expect(area.district).toBe('Kadıköy');
    expect(area.scope).toBe('DISTRICT');
    expect(area.areaKey).toBe(
      showcaseAreaKey({ city: 'İstanbul', district: 'Kadıköy', neighborhood: null }),
    );
  });

  it('gövdeden gelen scope ve areaKey alanlarını tümden reddeder', async () => {
    const { category, provider, cookie } = await providerFixture();

    // whitelist + forbidNonWhitelisted: bilinmeyen alan taşıyan gövde 400 olur,
    // yani istemci bir anahtar "önerme" imkânı bile bulamaz.
    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          areas: [{ city: 'İstanbul', district: 'Kadıköy', scope: 'CITY', areaKey: 'sahte|||' }],
        }),
      )
      .expect(400);
  });

  it('kanonik olmayan il/ilçe eşleşmesini reddeder', async () => {
    const { category, provider, cookie } = await providerFixture();

    // Çankaya Ankara'nın ilçesi; İstanbul ile birlikte bir yer adı değil.
    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, { areas: [{ city: 'İstanbul', district: 'Çankaya' }] }),
      )
      .expect(400);
  });

  it('sağlayıcının hizmet bölgeleri dışındaki alanı reddeder', async () => {
    const { category, provider, cookie } = await providerFixture({
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, { areas: [{ city: 'İstanbul', district: 'Beşiktaş' }] }),
      )
      .expect(409);

    expect(response.body.code).toBe('SHOWCASE_AREA_NOT_COVERED');
  });

  it('il geneli hizmet bölgesi altındaki ilçe kartını kabul eder', async () => {
    const { category, provider, cookie } = await providerFixture({
      areas: [{ city: 'İstanbul', district: null }],
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          areas: [
            { city: 'İstanbul', district: 'Beşiktaş' },
            { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
          ],
        }),
      )
      .expect(201);
  });

  it('ilçe hizmet bölgesi, il geneli kart iddiasını karşılamaz', async () => {
    const { category, provider, cookie } = await providerFixture({
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { areas: [{ city: 'İstanbul' }] }))
      .expect(409);

    expect(response.body.code).toBe('SHOWCASE_AREA_NOT_COVERED');
  });

  it('aynı bölgeyi iki farklı yazımla gönderen listeyi reddeder', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          areas: [
            { city: 'İstanbul', district: 'Kadıköy' },
            { city: 'istanbul', district: 'KADIKÖY' },
          ],
        }),
      )
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_AREA_DUPLICATE');
  });

  it('en az bir bölge ister', async () => {
    const { category, provider, cookie } = await providerFixture();

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { areas: [] }))
      .expect(400);
  });
});

describe('taslak düzenleme', () => {
  it('taslağı sürüm numarası harcamadan yerinde günceller', async () => {
    const { category, provider, cookie } = await providerFixture();

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id))
      .expect(201);

    const updated = await request(ctx.server)
      .patch(`/providers/${provider.id}/showcase/cards/${created.body.id}`)
      .set('Cookie', cookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Yeni başlık' }))
      .expect(200);

    expect(updated.body.draftVersion.id).toBe(created.body.draftVersion.id);
    expect(updated.body.draftVersion.versionNumber).toBe(1);
    expect(updated.body.draftVersion.title).toBe('Yeni başlık');

    const versions = await ctx.prisma.showcaseCardVersion.count({
      where: { cardId: created.body.id },
    });
    expect(versions).toBe(1);
  });
});
