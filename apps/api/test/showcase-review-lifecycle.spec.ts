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
  showcaseUpdatePayload,
  SHOWCASE_SUBMIT_BODY,
  type TestContext,
} from './harness';

/**
 * The life of a version: written, submitted, decided — and what happens to the
 * card underneath it while that goes on.
 *
 * The property this file is really about is one sentence: **a live card is not
 * disturbed by anything that happens to its replacement.** A provider editing an
 * approved card, an operator sitting on the new version for a week, an operator
 * refusing it outright — none of those may change what a customer would see.
 * Three separate cases below assert exactly that, because the three fail in
 * different places.
 *
 * The second property is the review row's meaning: an operator's decision is a
 * person's, is recorded with their name, and is written in the same transaction
 * as the effect it justifies.
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

/**
 * A provider with `rights` usable publication rights on the shelf — one by
 * default, since a card is opened on one and most cases open one card.
 */
async function fixture(options: { rights?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', {
    kind: ServiceCategoryKind.LEAF,
  });
  const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: providerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const pkg = await createShowcasePackage(ctx.prisma);
  const rights = [];
  for (let i = 0; i < (options.rights ?? 1); i += 1) {
    rights.push(
      await createShowcaseEntitlement(ctx, {
        providerId: provider.id,
        userId: providerUser.id,
        packageId: pkg.id,
      }),
    );
  }

  return {
    category,
    provider,
    providerCookie: await loginAs(ctx.prisma, providerUser.id),
    admin,
    adminCookie: await loginAs(ctx.prisma, admin.id),
    pkg,
    rights,
  };
}

/** Creates a card and hands it to an operator, returning the card body. */
async function createAndSubmit(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const created = await request(ctx.server)
    .post(`/providers/${f.provider.id}/showcase/cards`)
    .set('Cookie', f.providerCookie)
    .send(showcaseCardPayload(f.category.id, overrides))
    .expect(201);

  const submitted = await request(ctx.server)
    .post(`/providers/${f.provider.id}/showcase/cards/${created.body.id}/submit`)
    .set('Cookie', f.providerCookie)
    .send(SHOWCASE_SUBMIT_BODY)
    .expect(200);

  return submitted.body;
}

/** Creates, submits and approves — a card with a live version. */
async function createApproved(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const submitted = await createAndSubmit(f, overrides);

  await request(ctx.server)
    .post(`/admin/showcase/versions/${submitted.draftVersion.id}/approve`)
    .set('Cookie', f.adminCookie)
    .send({})
    .expect(200);

  const card = await request(ctx.server)
    .get(`/providers/${f.provider.id}/showcase/cards/${submitted.id}`)
    .set('Cookie', f.providerCookie)
    .expect(200);

  return card.body;
}

describe('incelemeye gönderme', () => {
  it('fiyat sorumluluk kabulünü kaydeder ve kartı PENDING_REVIEW yapar', async () => {
    const f = await fixture();
    const card = await createAndSubmit(f);

    expect(card.status).toBe('PENDING_REVIEW');
    expect(card.draftVersion.reviewStatus).toBe('PENDING');
    expect(card.draftVersion.priceTermsVersion).toBe('v1');
    expect(card.draftVersion.priceTermsAcceptedAt).not.toBeNull();
    expect(card.draftVersion.submittedAt).not.toBeNull();
    expect(card.liveVersion).toBeNull();
  });

  it('geçerli rezerve hakkı olmayan kart incelemeye gönderilemez', async () => {
    const f = await fixture();
    const created = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards`)
      .set('Cookie', f.providerCookie)
      .send(showcaseCardPayload(f.category.id))
      .expect(201);

    // Hak, kart taslakta beklerken süpürücü tarafından düşürülmüş gibi.
    await ctx.prisma.showcaseEntitlement.updateMany({
      where: { cardId: created.body.id },
      data: { status: 'EXPIRED', cardId: null, reservedAt: null, reviewPausedAt: null },
    });

    const response = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${created.body.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(409);
    expect(response.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');

    const untouched = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: created.body.draftVersion.id },
    });
    expect(untouched.reviewStatus).toBe('DRAFT');
    expect(untouched.priceTermsVersion).toBeNull();
    expect(untouched.submittedAt).toBeNull();
  });

  it('eski kabul alanlarını taşıyan submit gövdesi reddedilir', async () => {
    const f = await fixture();
    const created = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards`)
      .set('Cookie', f.providerCookie)
      .send(showcaseCardPayload(f.category.id))
      .expect(201);

    // Kabul artık paket satın alımında verilir; gövdede gelen eski alanlar
    // sessizce düşürülmez, whitelist 400 ile keser. Sürüm yerinden oynamaz.
    await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${created.body.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send({ priceTermsAccepted: true, priceTermsVersion: 'v1' })
      .expect(400);

    const untouched = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: created.body.draftVersion.id },
    });
    expect(untouched.reviewStatus).toBe('DRAFT');
  });

  it('incelemedeki sürüm düzenlenemez', async () => {
    const f = await fixture();
    const card = await createAndSubmit(f);

    const response = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Gizlice değiştir' }))
      .expect(409);

    expect(response.body.code).toBe('SHOWCASE_VERSION_UNDER_REVIEW');

    const stored = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: card.draftVersion.id },
    });
    expect(stored.title).toBe(card.draftVersion.title);
  });

  it('taslağı olmayan kart incelemeye gönderilemez', async () => {
    const f = await fixture();
    const card = await createApproved(f);

    const response = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(409);

    expect(response.body.code).toBe('SHOWCASE_NOTHING_TO_SUBMIT');
  });
});

describe('ilk sürüm onayı ve reddi', () => {
  it('onay canlı sürümü işaret eder, taslağı temizler ve audit satırı yazar', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    const approved = await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/approve`)
      .set('Cookie', f.adminCookie)
      .send({})
      .expect(200);

    expect(approved.body.reviewStatus).toBe('APPROVED');
    expect(approved.body.publishedAt).not.toBeNull();
    expect(approved.body.review.decision).toBe('APPROVED');
    expect(approved.body.review.reviewedBy.id).toBe(f.admin.id);
    // Bir onay, sağlayıcının okuduğu satırda operatör notu taşımaz.
    expect(approved.body.review.note).toBeNull();

    // İlk onay yayındır: hak tüketilir ve kartın yayını aynı işlemde doğar.
    expect(await ctx.prisma.showcasePlacement.count({ where: { cardId: submitted.id } })).toBe(1);
    expect(
      await ctx.prisma.showcaseEntitlement.count({
        where: { cardId: submitted.id, status: 'CONSUMED' },
      }),
    ).toBe(1);

    const card = await ctx.prisma.showcaseCard.findUniqueOrThrow({
      where: { id: submitted.id },
    });
    expect(card.liveVersionId).toBe(submitted.draftVersion.id);
    expect(card.draftVersionId).toBeNull();
    expect(card.status).toBe('APPROVED');
  });

  it('ilk sürüm reddedilirse kart REJECTED olur ve canlı sürüm oluşmaz', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    const rejected = await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/reject`)
      .set('Cookie', f.adminCookie)
      .send({ note: 'Kapsam listesi hizmet bedelini karşılamıyor.' })
      .expect(200);

    expect(rejected.body.reviewStatus).toBe('REJECTED');
    expect(rejected.body.review.note).toBe('Kapsam listesi hizmet bedelini karşılamıyor.');

    const card = await ctx.prisma.showcaseCard.findUniqueOrThrow({
      where: { id: submitted.id },
    });
    expect(card.status).toBe('REJECTED');
    expect(card.liveVersionId).toBeNull();
    expect(card.draftVersionId).toBeNull();

    // Taslak işaretçisi temizlendi; ama sahibinin okuyup düzelteceği metin
    // projeksiyonda `rejectedVersion` olarak hâlâ duruyor.
    const after = await request(ctx.server)
      .get(`/providers/${f.provider.id}/showcase/cards/${submitted.id}`)
      .set('Cookie', f.providerCookie)
      .expect(200);
    expect(after.body.draftVersion).toBeNull();
    expect(after.body.liveVersion).toBeNull();
    expect(after.body.rejectedVersion.id).toBe(submitted.draftVersion.id);
    expect(after.body.rejectedVersion.review.note).toBe(
      'Kapsam listesi hizmet bedelini karşılamıyor.',
    );
  });

  it('gerekçesiz ret kabul edilmez', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    for (const body of [{}, { note: '' }, { note: 'kısa' }]) {
      await request(ctx.server)
        .post(`/admin/showcase/versions/${submitted.draftVersion.id}/reject`)
        .set('Cookie', f.adminCookie)
        .send(body)
        .expect(400);
    }

    const stored = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: submitted.draftVersion.id },
    });
    expect(stored.reviewStatus).toBe('PENDING');
    const reviews = await ctx.prisma.showcaseCardReview.count();
    expect(reviews).toBe(0);
  });

  it('karara bağlanmış sürüm ikinci kez karara bağlanamaz', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/approve`)
      .set('Cookie', f.adminCookie)
      .send({})
      .expect(200);

    const second = await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/approve`)
      .set('Cookie', f.adminCookie)
      .send({})
      .expect(409);
    expect(second.body.code).toBe('SHOWCASE_VERSION_NOT_PENDING');

    const asReject = await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/reject`)
      .set('Cookie', f.adminCookie)
      .send({ note: 'Sonradan fikir değiştirdim.' })
      .expect(409);
    expect(asReject.body.code).toBe('SHOWCASE_VERSION_NOT_PENDING');

    // Tek karar, tek satır: unique index ve koşullu update birlikte tutuyor.
    const reviews = await ctx.prisma.showcaseCardReview.findMany({
      where: { cardVersionId: submitted.draftVersion.id },
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.decision).toBe('APPROVED');
  });
});

describe('canlı kartın yeni sürümü', () => {
  it('düzenleme canlı sürümü değiştirmez, yeni taslak açar', async () => {
    const f = await fixture();
    const card = await createApproved(f);
    const liveVersionId = card.liveVersion.id;

    const edited = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(
        showcaseUpdatePayload(f.category.id, {
          title: 'Yeni başlık',
          listedServicePriceAmount: 250000,
        }),
      )
      .expect(200);

    // Canlı sürüm bit düzeyinde aynı.
    expect(edited.body.liveVersion.id).toBe(liveVersionId);
    expect(edited.body.liveVersion.title).toBe(card.liveVersion.title);
    expect(edited.body.liveVersion.listedServicePriceAmount).toBe(
      card.liveVersion.listedServicePriceAmount,
    );
    // Yeni taslak ikinci sürüm.
    expect(edited.body.draftVersion.versionNumber).toBe(2);
    expect(edited.body.draftVersion.reviewStatus).toBe('DRAFT');
    expect(edited.body.status).toBe('APPROVED');
  });

  it('yeni sürüm incelemedeyken kart APPROVED ve canlı sürüm yerinde kalır', async () => {
    const f = await fixture();
    const card = await createApproved(f);
    const liveVersionId = card.liveVersion.id;

    await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'İnceleme bekleyen başlık' }))
      .expect(200);

    const submitted = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(200);

    expect(submitted.body.status).toBe('APPROVED');
    expect(submitted.body.liveVersion.id).toBe(liveVersionId);
    expect(submitted.body.draftVersion.reviewStatus).toBe('PENDING');
  });

  it('yeni sürüm reddedilirse eski canlı sürüm ve kart durumu korunur', async () => {
    const f = await fixture();
    const card = await createApproved(f);
    const liveVersionId = card.liveVersion.id;
    const liveTitle = card.liveVersion.title;

    await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Reddedilecek başlık' }))
      .expect(200);

    const submitted = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(200);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/reject`)
      .set('Cookie', f.adminCookie)
      .send({ note: 'Başlık hizmetin kapsamını yansıtmıyor.' })
      .expect(200);

    const after = await request(ctx.server)
      .get(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .expect(200);

    expect(after.body.status).toBe('APPROVED');
    expect(after.body.liveVersion.id).toBe(liveVersionId);
    expect(after.body.liveVersion.title).toBe(liveTitle);
    expect(after.body.draftVersion).toBeNull();
    // Canlı metni olan kart için ret geçmiştir, sahibinin düzelteceği bir
    // şey değil: `rejectedVersion` yalnız taslağı ve canlısı olmayan kartta dolar.
    expect(after.body.rejectedVersion).toBeNull();

    // Reddedilen sürüm gerekçesiyle birlikte geçmişte duruyor.
    const rejectedVersion = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: submitted.body.draftVersion.id },
      include: { review: true },
    });
    expect(rejectedVersion.reviewStatus).toBe('REJECTED');
    expect(rejectedVersion.review?.note).toBe('Başlık hizmetin kapsamını yansıtmıyor.');
  });

  it('yeni sürüm onaylanınca canlı sürüm devredilir, eski sürüm geçmişte kalır', async () => {
    const f = await fixture();
    const card = await createApproved(f);
    const firstVersionId = card.liveVersion.id;

    await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Onaylanacak başlık' }))
      .expect(200);

    const submitted = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(200);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`)
      .set('Cookie', f.adminCookie)
      .send({})
      .expect(200);

    const after = await request(ctx.server)
      .get(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .expect(200);

    expect(after.body.liveVersion.id).toBe(submitted.body.draftVersion.id);
    expect(after.body.liveVersion.title).toBe('Onaylanacak başlık');
    expect(after.body.draftVersion).toBeNull();

    const first = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: firstVersionId },
    });
    expect(first.reviewStatus).toBe('APPROVED');
  });

  it('reddedilen ilk sürümden sonraki düzenleme ikinci sürümü açar', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/reject`)
      .set('Cookie', f.adminCookie)
      .send({ note: 'Kapsam listesi eksik kalmış.' })
      .expect(200);

    const edited = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${submitted.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Düzeltilmiş başlık' }))
      .expect(200);

    expect(edited.body.draftVersion.versionNumber).toBe(2);
    expect(edited.body.draftVersion.reviewStatus).toBe('DRAFT');
    expect(edited.body.status).toBe('DRAFT');
    // Yeni taslak açılınca ret artık geçmiş: projeksiyon onu taşımıyor.
    expect(edited.body.rejectedVersion).toBeNull();

    // Reddedilen sürüm reddedildiği hâliyle duruyor.
    const rejected = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: submitted.draftVersion.id },
    });
    expect(rejected.reviewStatus).toBe('REJECTED');
    expect(rejected.title).toBe(submitted.draftVersion.title);
  });
});

describe('admin kararının bütünlüğü', () => {
  it('karar satırı, sürüm ve kart güncellemesiyle birlikte var olur', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/approve`)
      .set('Cookie', f.adminCookie)
      .send({})
      .expect(200);

    const review = await ctx.prisma.showcaseCardReview.findUniqueOrThrow({
      where: { cardVersionId: submitted.draftVersion.id },
    });
    const version = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: submitted.draftVersion.id },
    });
    const card = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: submitted.id } });

    expect(review.reviewedById).toBe(f.admin.id);
    expect(version.reviewStatus).toBe('APPROVED');
    expect(card.liveVersionId).toBe(version.id);
  });

  it('başarısız karar hiçbir satır bırakmaz', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    // Ret gerekçesi DTO'da kesiliyor: ne sürüm ne kart ne de karar satırı hareket eder.
    await request(ctx.server)
      .post(`/admin/showcase/versions/${submitted.draftVersion.id}/reject`)
      .set('Cookie', f.adminCookie)
      .send({ note: 'yok' })
      .expect(400);

    const version = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: submitted.draftVersion.id },
    });
    const card = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: submitted.id } });

    expect(version.reviewStatus).toBe('PENDING');
    expect(card.status).toBe('PENDING_REVIEW');
    expect(card.draftVersionId).toBe(version.id);
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
  });

  it('veritabanı, onay satırına operatör notu yazılmasını reddeder', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    // Uygulama bunu asla yazmaz; CHECK'in gerçekten var olduğunu kanıtlıyoruz.
    await expect(
      ctx.prisma.showcaseCardReview.create({
        data: {
          cardVersionId: submitted.draftVersion.id,
          decision: 'APPROVED',
          reviewedById: f.admin.id,
          note: 'Onaya iliştirilmiş operatör notu',
        },
      }),
    ).rejects.toThrow();
  });

  it('veritabanı, sistem adına yazılmış operatörsüz karar satırını reddeder', async () => {
    const f = await fixture();
    const submitted = await createAndSubmit(f);

    // reviewedById NOT NULL: "sistem onayladı" diye bir karar satırı yazılamaz.
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `INSERT INTO "ShowcaseCardReview" ("id", "cardVersionId", "decision", "reviewedById", "createdAt")
         VALUES ('sys-review', $1, 'APPROVED', NULL, now())`,
        submitted.draftVersion.id,
      ),
    ).rejects.toThrow();
  });

  it('inceleme kuyruğu yalnız bekleyen sürümleri, en eskisi başta listeler', async () => {
    const f = await fixture({ rights: 2 });
    const first = await createAndSubmit(f);
    const second = await createAndSubmit(f);

    await request(ctx.server)
      .post(`/admin/showcase/versions/${first.draftVersion.id}/approve`)
      .set('Cookie', f.adminCookie)
      .send({})
      .expect(200);

    const queue = await request(ctx.server)
      .get('/admin/showcase/versions')
      .set('Cookie', f.adminCookie)
      .expect(200);

    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].id).toBe(second.draftVersion.id);
    expect(queue.body[0].provider.id).toBe(f.provider.id);
  });
});
