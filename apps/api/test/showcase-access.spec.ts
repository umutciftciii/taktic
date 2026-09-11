import { ServiceCategoryKind, UserRole } from '@prisma/client';
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
  SHOWCASE_SUBMIT_BODY,
  type TestContext,
} from './harness';

/**
 * Who may reach which vitrin route, and what a refusal is allowed to reveal.
 *
 * The rule that costs the most to get wrong is the last one: **another
 * provider's card answers 404, never 403.** A 403 would confirm that the id is
 * real, and a card is a business's unpublished price list — walking the id space
 * to learn who is about to advertise what, and for how much, is exactly the
 * disclosure this product cannot allow. It is the same decision
 * `getProviderForViewer` already makes for a pending provider profile.
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

async function provider(categoryId: string) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId,
    areas: [{ city: 'İstanbul', district: null }],
  });
  // Each business holds one usable right, so a refusal below is never
  // "no package" wearing an access code's clothes.
  const pkg = await createShowcasePackage(ctx.prisma);
  await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });

  return { user, profile, cookie: await loginAs(ctx.prisma, user.id) };
}

async function scenario() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const owner = await provider(category.id);
  const stranger = await provider(category.id);
  const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

  const created = await request(ctx.server)
    .post(`/providers/${owner.profile.id}/showcase/cards`)
    .set('Cookie', owner.cookie)
    .send(showcaseCardPayload(category.id))
    .expect(201);

  return {
    category,
    owner,
    stranger,
    admin: { user: adminUser, cookie: await loginAs(ctx.prisma, adminUser.id) },
    customer: { user: customerUser, cookie: await loginAs(ctx.prisma, customerUser.id) },
    card: created.body,
  };
}

describe('sağlayıcı uçları — kimlik ve rol', () => {
  it('oturumsuz çağrı 401', async () => {
    const s = await scenario();

    await request(ctx.server)
      .get(`/providers/${s.owner.profile.id}/showcase/cards`)
      .expect(401);
    await request(ctx.server)
      .post(`/providers/${s.owner.profile.id}/showcase/cards`)
      .send(showcaseCardPayload(s.category.id))
      .expect(401);
  });

  it('hizmet alan hesabı 403', async () => {
    const s = await scenario();

    await request(ctx.server)
      .get(`/providers/${s.owner.profile.id}/showcase/cards`)
      .set('Cookie', s.customer.cookie)
      .expect(403);
    await request(ctx.server)
      .patch(`/providers/${s.owner.profile.id}/showcase/cards/${s.card.id}`)
      .set('Cookie', s.customer.cookie)
      .send({})
      .expect(403);
  });

  it('başka bir sağlayıcının paneline erişim 403', async () => {
    const s = await scenario();

    // Panelin kendisi başkasınındır: bu bir varlık sızıntısı değil, adres
    // hatasıdır — ProviderAccessGuard oturumu yoldaki providerId'ye bağlar.
    await request(ctx.server)
      .get(`/providers/${s.owner.profile.id}/showcase/cards`)
      .set('Cookie', s.stranger.cookie)
      .expect(403);
  });

  it('kendi panelinde başka sağlayıcının kartı 404 — 403 değil', async () => {
    const s = await scenario();

    // Yabancı kendi panelini kullanıyor ama sahibin kart kimliğini deniyor.
    // 403 "bu kimlik gerçek" demek olurdu; cevap, olmayan bir kartla aynıdır.
    const response = await request(ctx.server)
      .get(`/providers/${s.stranger.profile.id}/showcase/cards/${s.card.id}`)
      .set('Cookie', s.stranger.cookie)
      .expect(404);

    expect(response.body.code).toBe('SHOWCASE_CARD_NOT_FOUND');

    // Uydurma bir kimlik de tıpatıp aynı cevabı verir.
    const fabricated = await request(ctx.server)
      .get(`/providers/${s.stranger.profile.id}/showcase/cards/olmayan-kart`)
      .set('Cookie', s.stranger.cookie)
      .expect(404);

    expect(fabricated.body.code).toBe(response.body.code);
    expect(fabricated.body.message).toBe(response.body.message);
  });

  it('başka sağlayıcının kartı yazma uçlarında da 404', async () => {
    const s = await scenario();

    await request(ctx.server)
      .patch(`/providers/${s.stranger.profile.id}/showcase/cards/${s.card.id}`)
      .set('Cookie', s.stranger.cookie)
      // Gövde kendi başına tamamen geçerli: reddin sebebi biçim değil, kartın
      // bu panele ait olmaması.
      .send({
        title: 'Başkasının kartını ele geçir',
        summary: 'Bu değişiklik hiçbir zaman kaydedilmemeli.',
        scopeIncluded: ['Filtre temizliği'],
        scopeExcluded: ['Gaz dolumu'],
        listedServicePriceAmount: 100000,
        areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
      })
      .expect(404);

    await request(ctx.server)
      .post(`/providers/${s.stranger.profile.id}/showcase/cards/${s.card.id}/submit`)
      .set('Cookie', s.stranger.cookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(404);

    // Yabancının kendi hakkı var; yine de başkasının kartına bağlayamaz.
    await request(ctx.server)
      .post(`/providers/${s.stranger.profile.id}/showcase/cards/${s.card.id}/use-entitlement`)
      .set('Cookie', s.stranger.cookie)
      .send({})
      .expect(404);
    expect(
      await ctx.prisma.showcaseEntitlement.count({
        where: { providerId: s.stranger.profile.id, status: 'AVAILABLE' },
      }),
    ).toBe(1);

    // Sahibin kartı hiç kıpırdamadı.
    const stored = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: s.card.draftVersion.id },
    });
    expect(stored.title).toBe(s.card.draftVersion.title);
    expect(stored.reviewStatus).toBe('DRAFT');
  });

  it('sağlayıcı listesi yalnız kendi kartlarını döndürür', async () => {
    const s = await scenario();

    const list = await request(ctx.server)
      .get(`/providers/${s.stranger.profile.id}/showcase/cards`)
      .set('Cookie', s.stranger.cookie)
      .expect(200);

    expect(list.body).toEqual([]);
  });

  it('görsel yükleme ucu da aynı panel bağını uygular', async () => {
    const s = await scenario();

    await request(ctx.server)
      .post(`/providers/${s.owner.profile.id}/showcase/uploads/card-image`)
      .expect(401);

    await request(ctx.server)
      .post(`/providers/${s.owner.profile.id}/showcase/uploads/card-image`)
      .set('Cookie', s.customer.cookie)
      .expect(403);

    await request(ctx.server)
      .post(`/providers/${s.owner.profile.id}/showcase/uploads/card-image`)
      .set('Cookie', s.stranger.cookie)
      .expect(403);
  });
});

describe('admin uçları', () => {
  it('oturumsuz çağrı 401, sağlayıcı ve hizmet alan 403', async () => {
    const s = await scenario();

    const submitted = await request(ctx.server)
      .post(`/providers/${s.owner.profile.id}/showcase/cards/${s.card.id}/submit`)
      .set('Cookie', s.owner.cookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(200);

    const versionId = submitted.body.draftVersion.id;

    for (const [label, cookie, expected] of [
      ['oturumsuz', null, 401],
      ['sağlayıcı', s.owner.cookie, 403],
      ['hizmet alan', s.customer.cookie, 403],
    ] as Array<[string, string | null, number]>) {
      const routes: Array<[string, string]> = [
        ['get', '/admin/showcase/versions'],
        ['get', `/admin/showcase/versions/${versionId}`],
        ['get', '/admin/showcase/cards'],
        ['get', `/admin/showcase/cards/${s.card.id}`],
      ];

      for (const [method, path] of routes) {
        const call = request(ctx.server)[method as 'get'](path);
        if (cookie) call.set('Cookie', cookie);
        await call.expect(expected);
      }

      const approve = request(ctx.server).post(
        `/admin/showcase/versions/${versionId}/approve`,
      );
      if (cookie) approve.set('Cookie', cookie);
      await approve.send({}).expect(expected);

      const reject = request(ctx.server).post(`/admin/showcase/versions/${versionId}/reject`);
      if (cookie) reject.set('Cookie', cookie);
      await reject.send({ note: `${label} reddetmeye çalıştı.` }).expect(expected);
    }

    // Hiçbiri karar üretmedi.
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
    const version = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(version.reviewStatus).toBe('PENDING');
  });

  it('admin her sağlayıcının kartını görebilir', async () => {
    const s = await scenario();

    const cards = await request(ctx.server)
      .get('/admin/showcase/cards')
      .set('Cookie', s.admin.cookie)
      .expect(200);

    expect(cards.body).toHaveLength(1);
    expect(cards.body[0].id).toBe(s.card.id);
    expect(cards.body[0].provider.id).toBe(s.owner.profile.id);
  });

  it('olmayan sürüm 404', async () => {
    const s = await scenario();

    await request(ctx.server)
      .get('/admin/showcase/versions/olmayan-surum')
      .set('Cookie', s.admin.cookie)
      .expect(404);

    await request(ctx.server)
      .post('/admin/showcase/versions/olmayan-surum/approve')
      .set('Cookie', s.admin.cookie)
      .send({})
      .expect(404);
  });

  it('adminin sağlayıcı paneline erişimi mevcut sözleşmeye uygun şekilde açıktır', async () => {
    const s = await scenario();

    // SUPER_ADMIN, ProviderAccessGuard'ın her yerde tanıdığı istisnadır; vitrin
    // bu sözleşmeyi ne genişletir ne daraltır.
    const list = await request(ctx.server)
      .get(`/providers/${s.owner.profile.id}/showcase/cards`)
      .set('Cookie', s.admin.cookie)
      .expect(200);

    expect(list.body).toHaveLength(1);
  });
});
