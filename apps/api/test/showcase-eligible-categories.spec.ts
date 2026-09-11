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
  SHOWCASE_SUBMIT_BODY,
  type TestContext,
} from './harness';

/**
 * Which categories a business may put a card under — the list the form renders,
 * and the rule the write endpoints enforce.
 *
 * Two properties carry this file, and they are the same property seen from
 * either end:
 *
 * 1. **A card may only point at a service the business performs and a customer
 *    can actually ask for.** `canReceiveRequests` is the second half of that:
 *    a leaf the platform has closed takes no requests, so a card on it would
 *    advertise something nobody can order.
 * 2. **The list and the guard cannot disagree.** Every case below asserts both:
 *    what `eligible-categories` offers, and what `POST /cards` accepts. A list
 *    that offered more than the guard admits would be a dropdown full of
 *    refusals; one that offered less would hide a shape the product promises.
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

type EligibleCategory = { id: string; name: string; kind: string; depth: number; path: string[] };
type Eligible = { service: EligibleCategory[]; promotion: EligibleCategory[] };

async function providerBoundTo(categoryIds: string[]) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const [first, ...rest] = categoryIds;
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: first ?? '',
    areas: [{ city: 'İstanbul', district: null }],
  });

  for (const categoryId of rest) {
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId },
    });
  }

  // The list is read without one, but the cases that go on to open a card
  // need a right on the shelf; a refused create never touches it.
  const pkg = await createShowcasePackage(ctx.prisma);
  await createShowcaseEntitlement(ctx, { providerId: provider.id, userId: user.id, packageId: pkg.id });

  return { provider, cookie: await loginAs(ctx.prisma, user.id) };
}

function eligible(providerId: string, cookie: string) {
  return request(ctx.server)
    .get(`/providers/${providerId}/showcase/cards/eligible-categories`)
    .set('Cookie', cookie);
}

function createCard(
  providerId: string,
  cookie: string,
  categoryId: string,
  kind: 'SERVICE' | 'PROMOTION' = 'SERVICE',
) {
  return request(ctx.server)
    .post(`/providers/${providerId}/showcase/cards`)
    .set('Cookie', cookie)
    .send(
      showcaseCardPayload(categoryId, {
        kind,
        listedServicePriceAmount: kind === 'SERVICE' ? 150000 : null,
        areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
      }),
    );
}

describe('uygun kategori listesi', () => {
  it('SERVICE yalnız bağlı ve talep alabilen LEAF; GROUP hiç görünmez', async () => {
    const group = await createCategory(ctx.prisma, 'Ev Bakımı', {
      kind: ServiceCategoryKind.GROUP,
    });
    const leaf = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
    });
    const { provider, cookie } = await providerBoundTo([leaf.id]);

    const response = await eligible(provider.id, cookie).expect(200);
    const body = response.body as Eligible;

    expect(body.service.map((entry) => entry.id)).toEqual([leaf.id]);
    expect(body.service.every((entry) => entry.kind === 'LEAF')).toBe(true);
    // The group is a promotion-only shape and must not leak into the service list.
    expect(body.service.some((entry) => entry.id === group.id)).toBe(false);
  });

  it('PROMOTION, bağlı LEAF’lerin üstündeki uygun GROUP’ları da içerir', async () => {
    const root = await createCategory(ctx.prisma, 'Ev Hizmetleri', {
      kind: ServiceCategoryKind.GROUP,
      sortOrder: 1,
    });
    const inner = await createCategory(ctx.prisma, 'İklimlendirme', {
      kind: ServiceCategoryKind.GROUP,
      parentId: root.id,
      sortOrder: 1,
    });
    const leaf = await createCategory(ctx.prisma, 'Klima bakımı', {
      kind: ServiceCategoryKind.LEAF,
      parentId: inner.id,
      sortOrder: 1,
    });
    const { provider, cookie } = await providerBoundTo([leaf.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;
    const ids = body.promotion.map((entry) => entry.id);

    expect(ids).toContain(leaf.id);
    expect(ids).toContain(inner.id);
    expect(ids).toContain(root.id);

    // Hiyerarşik sıra: kök, altındaki grup, sonra yaprak.
    expect(ids).toEqual([root.id, inner.id, leaf.id]);
    expect(body.promotion.map((entry) => entry.depth)).toEqual([0, 1, 2]);
    expect(body.promotion[2]?.path).toEqual([root.name, inner.name, leaf.name]);
  });

  it('aynı GROUP birden çok LEAF üzerinden gelse de bir kez görünür', async () => {
    const group = await createCategory(ctx.prisma, 'Ev Bakımı', {
      kind: ServiceCategoryKind.GROUP,
    });
    const first = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
      sortOrder: 1,
    });
    const second = await createCategory(ctx.prisma, 'Kombi', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
      sortOrder: 2,
    });
    const { provider, cookie } = await providerBoundTo([first.id, second.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;
    const groupEntries = body.promotion.filter((entry) => entry.id === group.id);

    expect(groupEntries).toHaveLength(1);
    expect(body.promotion.map((entry) => entry.id)).toEqual([group.id, first.id, second.id]);
  });

  it('ilgisiz GROUP hiçbir listede görünmez', async () => {
    const ownGroup = await createCategory(ctx.prisma, 'Ev Bakımı', {
      kind: ServiceCategoryKind.GROUP,
    });
    const leaf = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: ownGroup.id,
    });
    const unrelated = await createCategory(ctx.prisma, 'Nakliyat', {
      kind: ServiceCategoryKind.GROUP,
    });
    await createCategory(ctx.prisma, 'Evden eve', {
      kind: ServiceCategoryKind.LEAF,
      parentId: unrelated.id,
    });
    const { provider, cookie } = await providerBoundTo([leaf.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;

    expect(body.promotion.some((entry) => entry.id === unrelated.id)).toBe(false);
    expect(body.service.some((entry) => entry.id === unrelated.id)).toBe(false);
  });

  it('INACTIVE grup, altında uygun hizmet olsa bile listelenmez', async () => {
    const group = await createCategory(ctx.prisma, 'Kapanmış Raf', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.INACTIVE,
    });
    const leaf = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
    });
    const { provider, cookie } = await providerBoundTo([leaf.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;

    expect(body.service.map((entry) => entry.id)).toEqual([leaf.id]);
    expect(body.promotion.map((entry) => entry.id)).toEqual([leaf.id]);
  });

  it('talep alamayan bağlar hiçbir listede görünmez', async () => {
    const active = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const inactive = await createCategory(ctx.prisma, 'Kapalı hizmet', {
      kind: ServiceCategoryKind.LEAF,
      status: ServiceCategoryStatus.INACTIVE,
    });
    const draft = await createCategory(ctx.prisma, 'Taslak hizmet', {
      kind: ServiceCategoryKind.LEAF,
      status: ServiceCategoryStatus.DRAFT,
    });
    const { provider, cookie } = await providerBoundTo([active.id, inactive.id, draft.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;

    expect(body.service.map((entry) => entry.id)).toEqual([active.id]);
    expect(body.promotion.map((entry) => entry.id)).toEqual([active.id]);
  });

  it('uygun kategorisi olmayan sağlayıcıya iki boş liste döner', async () => {
    const inactive = await createCategory(ctx.prisma, 'Kapalı hizmet', {
      kind: ServiceCategoryKind.LEAF,
      status: ServiceCategoryStatus.INACTIVE,
    });
    const { provider, cookie } = await providerBoundTo([inactive.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;

    expect(body.service).toEqual([]);
    expect(body.promotion).toEqual([]);
  });

  it('liste ucu da panel bağını uygular', async () => {
    const leaf = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const { provider } = await providerBoundTo([leaf.id]);
    const stranger = await providerBoundTo([leaf.id]);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    await request(ctx.server)
      .get(`/providers/${provider.id}/showcase/cards/eligible-categories`)
      .expect(401);
    await eligible(provider.id, await loginAs(ctx.prisma, customer.id)).expect(403);
    await eligible(provider.id, stranger.cookie).expect(403);
  });
});

describe('liste ile API kuralı aynı şeyi söyler', () => {
  it('listelenen GROUP ile PROMOTION kartı açılabilir', async () => {
    const group = await createCategory(ctx.prisma, 'Ev Bakımı', {
      kind: ServiceCategoryKind.GROUP,
    });
    const leaf = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
    });
    const { provider, cookie } = await providerBoundTo([leaf.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;
    expect(body.promotion.some((entry) => entry.id === group.id)).toBe(true);

    const created = await createCard(provider.id, cookie, group.id, 'PROMOTION').expect(201);
    expect(created.body.kind).toBe('PROMOTION');
    expect(created.body.category.id).toBe(group.id);
  });

  it('listelenmeyen GROUP ile PROMOTION kartı açılamaz', async () => {
    const group = await createCategory(ctx.prisma, 'Kapanmış Raf', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.INACTIVE,
    });
    const leaf = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
    });
    const { provider, cookie } = await providerBoundTo([leaf.id]);

    const response = await createCard(provider.id, cookie, group.id, 'PROMOTION').expect(400);
    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it('grubun altında yalnız talep alamayan bağ varsa create ve submit reddedilir', async () => {
    const group = await createCategory(ctx.prisma, 'Ev Bakımı', {
      kind: ServiceCategoryKind.GROUP,
    });
    const closed = await createCategory(ctx.prisma, 'Kapalı hizmet', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
      status: ServiceCategoryStatus.INACTIVE,
    });
    // İkinci, uygun bir hizmet — ama grubun altında değil.
    const elsewhere = await createCategory(ctx.prisma, 'Boya', {
      kind: ServiceCategoryKind.LEAF,
    });
    const { provider, cookie } = await providerBoundTo([closed.id, elsewhere.id]);

    const body = (await eligible(provider.id, cookie).expect(200)).body as Eligible;
    expect(body.promotion.some((entry) => entry.id === group.id)).toBe(false);

    const response = await createCard(provider.id, cookie, group.id, 'PROMOTION').expect(400);
    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');

    // Aynı grup, kart zaten varken de submit edilemez: kartı uygun bir hizmetle
    // açıp altındaki tek bağı kapatınca aynı yere geliyoruz.
    const okLeaf = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      parentId: group.id,
    });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: okLeaf.id },
    });

    const card = await createCard(provider.id, cookie, group.id, 'PROMOTION').expect(201);

    await ctx.prisma.serviceCategory.update({
      where: { id: okLeaf.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });

    const submit = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards/${card.body.id}/submit`)
      .set('Cookie', cookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(400);
    expect(submit.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });
});

describe('talep alamayan kategori', () => {
  it('INACTIVE LEAF ile kart açılamaz', async () => {
    const leaf = await createCategory(ctx.prisma, 'Kapalı hizmet', {
      kind: ServiceCategoryKind.LEAF,
      status: ServiceCategoryStatus.INACTIVE,
    });
    const { provider, cookie } = await providerBoundTo([leaf.id]);

    const response = await createCard(provider.id, cookie, leaf.id).expect(400);
    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it('kart açıldıktan sonra kategori kapanırsa taslak düzenlenemez ve gönderilemez', async () => {
    const leaf = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const { provider, cookie } = await providerBoundTo([leaf.id]);
    const card = await createCard(provider.id, cookie, leaf.id).expect(201);

    await ctx.prisma.serviceCategory.update({
      where: { id: leaf.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });

    const edit = await request(ctx.server)
      .patch(`/providers/${provider.id}/showcase/cards/${card.body.id}`)
      .set('Cookie', cookie)
      .send(showcaseUpdatePayload(leaf.id, { areas: [{ city: 'İstanbul', district: 'Kadıköy' }] }))
      .expect(400);
    expect(edit.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');

    const submit = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards/${card.body.id}/submit`)
      .set('Cookie', cookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(400);
    expect(submit.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');

    // Kart ve sürümü olduğu gibi duruyor: kural ileriye dönük, geriye değil.
    const stored = await ctx.prisma.showcaseCardVersion.findFirstOrThrow({
      where: { cardId: card.body.id },
    });
    expect(stored.reviewStatus).toBe('DRAFT');
    expect(stored.submittedAt).toBeNull();
  });

  it('onaylanmış kart, kategorisi kapansa da olduğu gibi kalır', async () => {
    const leaf = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const { provider, cookie } = await providerBoundTo([leaf.id]);
    const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, adminUser.id);

    const card = await createCard(provider.id, cookie, leaf.id).expect(201);
    const submitted = await request(ctx.server)
      .post(`/providers/${provider.id}/showcase/cards/${card.body.id}/submit`)
      .set('Cookie', cookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(200);
    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(200);

    await ctx.prisma.serviceCategory.update({
      where: { id: leaf.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });

    // Hiçbir geriye dönük değişiklik yok: kart APPROVED, canlı sürüm yerinde.
    const after = await request(ctx.server)
      .get(`/providers/${provider.id}/showcase/cards/${card.body.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(after.body.status).toBe('APPROVED');
    expect(after.body.liveVersion.id).toBe(submitted.body.draftVersion.id);
    expect(after.body.liveVersion.reviewStatus).toBe('APPROVED');
  });

  it('var olmayan, bağlı olmayan ve talep alamayan kategori aynı gövdeyi verir', async () => {
    const bound = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const inactive = await createCategory(ctx.prisma, 'Kapalı hizmet', {
      kind: ServiceCategoryKind.LEAF,
      status: ServiceCategoryStatus.INACTIVE,
    });
    const unbound = await createCategory(ctx.prisma, 'Boya', { kind: ServiceCategoryKind.LEAF });
    const { provider, cookie } = await providerBoundTo([bound.id, inactive.id]);

    const bodies = await Promise.all(
      [inactive.id, unbound.id, 'olmayan-kategori'].map(async (categoryId) => {
        const response = await createCard(provider.id, cookie, categoryId).expect(400);
        return response.body;
      }),
    );

    // Üçü de bit düzeyinde aynı: hangi kimliğin gerçek bir kategori olduğu ve
    // hangisinin kapalı olduğu bu uçtan öğrenilemez.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0].code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });
});
