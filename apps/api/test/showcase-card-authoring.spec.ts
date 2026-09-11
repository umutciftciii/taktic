import { ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createDiscoverableProvider,
  createShowcaseEntitlement,
  createShowcasePackage,
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
 *   containment test their profile form uses, and no two areas on one version
 *   may swallow each other.
 * - **A card may not advertise a service the business does not offer.** The
 *   category has to be one of the provider's live `ProviderServiceCategory`
 *   bindings — or, for a general card on a group, a group with one of those
 *   bindings underneath it.
 *
 * Every category refusal answers with one body, so this endpoint cannot be used
 * to ask whether an id names a real category or what the unreleased catalogue
 * contains.
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

  // A card is opened on a purchased right; every case here that reaches the
  // create endpoint needs one on the shelf. Cases that are refused before the
  // transaction never touch it.
  const pkg = await createShowcasePackage(ctx.prisma);
  const { entitlement } = await createShowcaseEntitlement(ctx, {
    providerId: provider.id,
    userId: user.id,
    packageId: pkg.id,
  });

  return { category, user, provider, cookie, pkg, entitlement };
}

describe('vitrin kartı oluşturma', () => {
  it('bir SERVICE kartını taslak sürümüyle birlikte açar', async () => {
    const { category, provider, cookie, entitlement } = await providerFixture();

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

    // The right the card was opened on is bound to it in the same transaction.
    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(right.status).toBe('RESERVED');
    expect(right.cardId).toBe(response.body.id);
  });

  it('SERVICE kartını fiyatsız kabul etmez', async () => {
    const { category, provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id, { listedServicePriceAmount: null }))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CONTENT_INVALID');
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

    expect(response.body.code).toBe('SHOWCASE_CONTENT_INVALID');
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

    expect(response.body.code).toBe('SHOWCASE_CONTENT_INVALID');
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

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it('PROMOTION kartını, altında bağlı hizmeti olan GROUP kategoriye bağlar', async () => {
    const group = await createCategory(ctx.prisma, 'Ev Bakımı', {
      kind: ServiceCategoryKind.GROUP,
    });
    const leaf = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
    });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    // Sağlayıcı gruba değil, grubun altındaki hizmete bağlı — ürünün "arz"
    // saydığı tek bağ budur.
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: user.id,
      categoryId: leaf.id,
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });
    const cookie = await loginAs(ctx.prisma, user.id);
    const pkg = await createShowcasePackage(ctx.prisma);
    await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: pkg.id });

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(group.id, { kind: 'PROMOTION', listedServicePriceAmount: null }))
      .expect(201);
  });

  it('PROMOTION kartını, altında bağlı hizmeti olmayan GROUP kategoriye açtırmaz', async () => {
    const group = await createCategory(ctx.prisma, 'Nakliyat', {
      kind: ServiceCategoryKind.GROUP,
    });
    // Sağlayıcının bağlı olduğu hizmet bu grubun altında değil, ayrı bir kök.
    const { provider, cookie } = await providerFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(group.id, { kind: 'PROMOTION', listedServicePriceAmount: null }))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it('gruba doğrudan bağlı olmak, grubun altında hizmet verildiği anlamına gelmez', async () => {
    // Sağlayıcı grubun kendisine bağlı ama altında hiçbir LEAF bağı yok.
    // "Rafın kendisine bağlı olmak" ürünün hiçbir yerinde arz sayılmaz.
    const { category, provider, cookie } = await providerFixture({
      categoryKind: ServiceCategoryKind.GROUP,
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, { kind: 'PROMOTION', listedServicePriceAmount: null }),
      )
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it('sağlayıcının sunmadığı LEAF kategoriye SERVICE kartı açtırmaz', async () => {
    const { provider, cookie } = await providerFixture();
    // Gerçek, yayında ve LEAF — ama bu işletmenin hizmet listesinde yok.
    const unrelated = await createCategory(ctx.prisma, 'Boya', {
      kind: ServiceCategoryKind.LEAF,
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(unrelated.id))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it('bağlı olmayan kategori ile hiç var olmayan kategori aynı cevabı verir', async () => {
    const { provider, cookie } = await providerFixture();
    const unrelated = await createCategory(ctx.prisma, 'Boya', {
      kind: ServiceCategoryKind.LEAF,
    });

    const real = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(unrelated.id))
      .expect(400);

    const fabricated = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload('olmayan-kategori'))
      .expect(400);

    // Gövde bit düzeyinde aynı: "bu kimlik gerçek bir kategori mi" sorusu
    // cevaplanmıyor.
    expect(fabricated.body).toEqual(real.body);
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

      expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
    }
  });

  it('DRAFT kategoriyi reddeder — bağ olsa bile, yayınlanmamış katalog sızmaz', async () => {
    // Bağ var ama kategori DRAFT: operatörün release hazırlığı, arz değil.
    // `visibleServiceCategories` de bu bağı sağlayıcının hizmet listesinde
    // saymaz, ve burada da saymıyoruz — aynı `isLiveProviderBinding` kuralı.
    const { category, provider, cookie } = await providerFixture({
      categoryStatus: ServiceCategoryStatus.DRAFT,
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
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

  it('kapsayan ve kapsanan iki bölgeyi birlikte kabul etmez', async () => {
    const { category, provider, cookie } = await providerFixture({
      areas: [{ city: 'İstanbul', district: null }],
    });

    // İl geneli, ilçeyi zaten kapsıyor.
    const cityAndDistrict = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          areas: [{ city: 'İstanbul' }, { city: 'İstanbul', district: 'Kadıköy' }],
        }),
      )
      .expect(400);
    expect(cityAndDistrict.body.code).toBe('SHOWCASE_AREA_OVERLAP');

    // Sıra fark etmez: dar olan önce gelse de aynı çift.
    const reversed = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          areas: [{ city: 'İstanbul', district: 'Kadıköy' }, { city: 'İstanbul' }],
        }),
      )
      .expect(400);
    expect(reversed.body.code).toBe('SHOWCASE_AREA_OVERLAP');

    // İlçe, altındaki mahalleyi kapsıyor.
    const districtAndNeighborhood = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          areas: [
            { city: 'İstanbul', district: 'Kadıköy' },
            { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
          ],
        }),
      )
      .expect(400);
    expect(districtAndNeighborhood.body.code).toBe('SHOWCASE_AREA_OVERLAP');
  });

  it('aynı hiyerarşide olmayan kardeş bölgeleri kabul eder', async () => {
    const { category, provider, cookie } = await providerFixture({
      areas: [{ city: 'İstanbul', district: null }],
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, {
          areas: [
            { city: 'İstanbul', district: 'Kadıköy' },
            { city: 'İstanbul', district: 'Beşiktaş' },
            { city: 'İstanbul', district: 'Üsküdar', neighborhood: 'Kuzguncuk Mah' },
          ],
        }),
      )
      .expect(201);

    expect(response.body.draftVersion.areas).toHaveLength(3);
  });

  it('sağlayıcının kendi örtüşen bölge kayıtları kartı engellemez', async () => {
    // ProviderServiceArea, kural gelmeden önce yazılmış örtüşen çiftleri
    // taşıyabilir ("İstanbul geneli" + "İstanbul/Kadıköy"). Bu kural yalnız
    // kart sürümünün kendi alan listesine uygulanır; profilin geçmişi bir kart
    // değildir ve buradan bir karta dönüşmez.
    const { category, provider, cookie } = await providerFixture({
      areas: [
        { city: 'İstanbul', district: null },
        { city: 'İstanbul', district: 'Kadıköy' },
      ],
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(
        showcaseCardPayload(category.id, { areas: [{ city: 'İstanbul', district: 'Kadıköy' }] }),
      )
      .expect(201);
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
