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
 * Taking a submission back, and what that must not disturb.
 *
 * A submitted version is frozen so the review row names the text an operator
 * actually read. Frozen is not the same as stuck: without a way back, a provider
 * who spots their own typo has to wait to be refused, which spends an operator's
 * attention on a mistake nobody disputes.
 *
 * So withdrawing exists — and everything below is about it being a *retrieval*
 * rather than a decision:
 *
 * - it writes no `ShowcaseCardReview`, because nobody judged anything;
 * - it never touches the live version, so a working card stays on the air;
 * - it clears the price-terms acceptance, because that acceptance belonged to a
 *   submission that no longer exists;
 * - and it cannot both happen and be overtaken by an operator's decision.
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

async function fixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: providerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  // One right on the shelf: every case here opens exactly one card on it.
  const pkg = await createShowcasePackage(ctx.prisma);
  const { entitlement } = await createShowcaseEntitlement(ctx, {
    providerId: provider.id,
    userId: providerUser.id,
    packageId: pkg.id,
  });

  return {
    category,
    provider,
    providerUser,
    providerCookie: await loginAs(ctx.prisma, providerUser.id),
    admin: adminUser,
    adminCookie: await loginAs(ctx.prisma, adminUser.id),
    entitlement,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function createCard(f: Fixture, overrides: Record<string, unknown> = {}) {
  const created = await request(ctx.server)
    .post(`/providers/${f.provider.id}/showcase/cards`)
    .set('Cookie', f.providerCookie)
    .send(showcaseCardPayload(f.category.id, overrides))
    .expect(201);

  return created.body;
}

async function submit(f: Fixture, cardId: string) {
  const submitted = await request(ctx.server)
    .post(`/providers/${f.provider.id}/showcase/cards/${cardId}/submit`)
    .set('Cookie', f.providerCookie)
    .send(SHOWCASE_SUBMIT_BODY)
    .expect(200);

  return submitted.body;
}

/** Deliberately not `async`: callers chain `.expect()` on the supertest test. */
function approve(f: Fixture, versionId: string) {
  return request(ctx.server)
    .post(`/admin/showcase/versions/${versionId}/approve`)
    .set('Cookie', f.adminCookie)
    .send({});
}

/** A card with a live version and a second version waiting on an operator. */
async function approvedCardWithPendingSecondVersion(f: Fixture) {
  const card = await createCard(f);
  const first = await submit(f, card.id);
  await approve(f, first.draftVersion.id).expect(200);

  await request(ctx.server)
    .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
    .set('Cookie', f.providerCookie)
    .send(showcaseUpdatePayload(f.category.id, { title: 'İkinci sürüm başlığı' }))
    .expect(200);

  const submitted = await submit(f, card.id);
  return { cardId: card.id, liveVersionId: first.draftVersion.id, pending: submitted.draftVersion };
}

describe('incelemedeki sürümü geri çekme', () => {
  it('sürümü DRAFT’a döndürür ve fiyat kabulünü temizler', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);

    expect(submitted.draftVersion.reviewStatus).toBe('PENDING');
    expect(submitted.draftVersion.priceTermsVersion).toBe('v1');

    const withdrawn = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(200);

    // Aynı sürüm — yeni bir sürüm numarası harcanmadı.
    expect(withdrawn.body.draftVersion.id).toBe(submitted.draftVersion.id);
    expect(withdrawn.body.draftVersion.versionNumber).toBe(1);
    expect(withdrawn.body.draftVersion.reviewStatus).toBe('DRAFT');
    expect(withdrawn.body.draftVersion.submittedAt).toBeNull();
    expect(withdrawn.body.draftVersion.priceTermsVersion).toBeNull();
    expect(withdrawn.body.draftVersion.priceTermsAcceptedAt).toBeNull();
    // Canlı sürümü olmayan kart taslağa döner.
    expect(withdrawn.body.status).toBe('DRAFT');
    expect(withdrawn.body.liveVersion).toBeNull();

    // Hak kartta kalır, saati yeniden işler: inceleme duraklaması WITHDRAWN
    // olarak kapanır.
    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { id: f.entitlement.id },
    });
    expect(right.status).toBe('RESERVED');
    expect(right.cardId).toBe(card.id);
    expect(right.reviewPausedAt).toBeNull();
    expect(
      await ctx.prisma.showcaseEntitlementReviewPause.count({
        where: { entitlementId: right.id, endReason: 'WITHDRAWN' },
      }),
    ).toBe(1);
  });

  it('geri çekilen sürüm yeniden düzenlenebilir', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);

    // İncelemedeyken düzenleme reddedilir…
    await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Düzeltilmiş' }))
      .expect(409);

    await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(200);

    // …geri çektikten sonra kabul edilir, hâlâ aynı sürümün üstüne.
    const edited = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Düzeltilmiş' }))
      .expect(200);

    expect(edited.body.draftVersion.id).toBe(submitted.draftVersion.id);
    expect(edited.body.draftVersion.title).toBe('Düzeltilmiş');
    expect(
      await ctx.prisma.showcaseCardVersion.count({ where: { cardId: card.id } }),
    ).toBe(1);
  });

  it('yeniden gönderim şart anlık görüntüsünü haktan yeniden yazar ve saati yeniden durdurur', async () => {
    const f = await fixture();
    const card = await createCard(f);
    await submit(f, card.id);
    await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(200);

    const stored = await ctx.prisma.showcaseCardVersion.findFirstOrThrow({
      where: { cardId: card.id },
    });
    expect(stored.reviewStatus).toBe('DRAFT');
    expect(stored.priceTermsAcceptedAt).toBeNull();

    // Yeniden gönderim: şart sürümü haktan yazılır, ikinci bir duraklama açılır.
    const resubmitted = await submit(f, card.id);
    expect(resubmitted.draftVersion.reviewStatus).toBe('PENDING');
    expect(resubmitted.draftVersion.priceTermsVersion).toBe('v1');
    expect(resubmitted.draftVersion.priceTermsAcceptedAt).not.toBeNull();

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({
      where: { id: f.entitlement.id },
    });
    expect(right.reviewPausedAt).not.toBeNull();
    expect(
      await ctx.prisma.showcaseEntitlementReviewPause.count({
        where: { entitlementId: right.id },
      }),
    ).toBe(2);
    expect(
      await ctx.prisma.showcaseEntitlementReviewPause.count({
        where: { entitlementId: right.id, endedAt: null },
      }),
    ).toBe(1);
  });

  it('canlı sürümü olan kartta canlı içerik ve kart durumu korunur', async () => {
    const f = await fixture();
    const { cardId, liveVersionId, pending } = await approvedCardWithPendingSecondVersion(f);

    const withdrawn = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${cardId}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(200);

    expect(withdrawn.body.status).toBe('APPROVED');
    expect(withdrawn.body.liveVersion.id).toBe(liveVersionId);
    expect(withdrawn.body.draftVersion.id).toBe(pending.id);
    expect(withdrawn.body.draftVersion.reviewStatus).toBe('DRAFT');

    // Canlı sürümün kendi kabulü el değmeden duruyor.
    const live = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: liveVersionId },
    });
    expect(live.reviewStatus).toBe('APPROVED');
    expect(live.priceTermsVersion).toBe('v1');
    expect(live.submittedAt).not.toBeNull();
  });

  it('geri çekilen sürüm admin kuyruğundan düşer', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);

    const beforeQueue = await request(ctx.server)
      .get('/admin/showcase/versions')
      .set('Cookie', f.adminCookie)
      .expect(200);
    expect(beforeQueue.body.map((entry: { id: string }) => entry.id)).toContain(
      submitted.draftVersion.id,
    );

    await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(200);

    const afterQueue = await request(ctx.server)
      .get('/admin/showcase/versions')
      .set('Cookie', f.adminCookie)
      .expect(200);
    expect(afterQueue.body.map((entry: { id: string }) => entry.id)).not.toContain(
      submitted.draftVersion.id,
    );
  });

  it('karar verilmiş sürüm geri çekilemez', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);
    await approve(f, submitted.draftVersion.id).expect(200);

    const response = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(409);

    expect(response.body.code).toBe('SHOWCASE_NOTHING_TO_WITHDRAW');

    const live = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: submitted.draftVersion.id },
    });
    expect(live.reviewStatus).toBe('APPROVED');
    expect(live.priceTermsVersion).toBe('v1');
  });

  it('gönderilmemiş taslak geri çekilemez', async () => {
    const f = await fixture();
    const card = await createCard(f);

    const response = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(409);

    expect(response.body.code).toBe('SHOWCASE_NOTHING_TO_WITHDRAW');
  });
});

describe('geri çekme denetim izi', () => {
  it('gerçek sağlayıcı ve sürümle yazılır; review satırı yazılmaz', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);
    const submittedAt = submitted.draftVersion.submittedAt as string;

    await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(200);

    const audits = await ctx.prisma.showcaseSubmissionWithdrawal.findMany({
      where: { cardId: card.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.providerId).toBe(f.provider.id);
    expect(audits[0]?.cardVersionId).toBe(submitted.draftVersion.id);
    // Sürümün kendi submittedAt'i temizlendi; hangi gönderimin geri çekildiğini
    // söyleyen tek şey bu kopya.
    expect(audits[0]?.submittedAtSnapshot.toISOString()).toBe(new Date(submittedAt).toISOString());

    // Geri çekme bir operatör kararı değildir ve o tabloya hiç dokunmaz.
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
  });

  it('aynı sürümün ikinci geri çekilişi ikinci satır yazar', async () => {
    const f = await fixture();
    const card = await createCard(f);

    for (let round = 0; round < 2; round += 1) {
      await submit(f, card.id);
      await request(ctx.server)
        .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
        .set('Cookie', f.providerCookie)
        .send({})
        .expect(200);
    }

    const audits = await ctx.prisma.showcaseSubmissionWithdrawal.findMany({
      where: { cardId: card.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(audits).toHaveLength(2);
    // İki ayrı gönderim, iki ayrı kayıt: `cardVersionId` unique olsaydı
    // birincisi kaybolurdu.
    expect(audits[0]?.cardVersionId).toBe(audits[1]?.cardVersionId);
    expect(audits[0]?.submittedAtSnapshot.getTime()).not.toBe(
      audits[1]?.submittedAtSnapshot.getTime(),
    );
  });
});

describe('geri çekme ile admin kararı yarışı', () => {
  it('admin önce karar verirse geri çekme reddedilir ve hiçbir şey değişmez', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);

    await approve(f, submitted.draftVersion.id).expect(200);

    const late = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(409);
    expect(late.body.code).toBe('SHOWCASE_NOTHING_TO_WITHDRAW');

    const stored = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(stored.liveVersionId).toBe(submitted.draftVersion.id);
    expect(stored.draftVersionId).toBeNull();
    expect(await ctx.prisma.showcaseSubmissionWithdrawal.count()).toBe(0);
  });

  it('sağlayıcı önce geri çekerse admin kararı reddedilir', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);

    await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
      .set('Cookie', f.providerCookie)
      .send({})
      .expect(200);

    const late = await approve(f, submitted.draftVersion.id).expect(409);
    expect(late.body.code).toBe('SHOWCASE_VERSION_NOT_PENDING');

    const stored = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(stored.liveVersionId).toBeNull();
    expect(stored.draftVersionId).toBe(submitted.draftVersion.id);
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
  });

  it('aynı anda gelen geri çekme ve onaydan yalnız biri kazanır', async () => {
    const f = await fixture();
    const card = await createCard(f);
    const submitted = await submit(f, card.id);
    const versionId = submitted.draftVersion.id;

    const [withdrawResult, approveResult] = await Promise.all([
      request(ctx.server)
        .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/withdraw-submission`)
        .set('Cookie', f.providerCookie)
        .send({}),
      approve(f, versionId),
    ]);

    const statuses = [withdrawResult.status, approveResult.status].sort();
    // Tam olarak biri 200, diğeri 409. İkisi de 200 olsaydı karar ile geri
    // çekme aynı sürüm üzerinde birlikte gerçekleşmiş olurdu.
    expect(statuses).toEqual([200, 409]);

    const version = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    const stored = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: card.id } });
    const reviews = await ctx.prisma.showcaseCardReview.count();
    const withdrawals = await ctx.prisma.showcaseSubmissionWithdrawal.count();

    if (withdrawResult.status === 200) {
      expect(version.reviewStatus).toBe('DRAFT');
      expect(version.priceTermsVersion).toBeNull();
      expect(stored.liveVersionId).toBeNull();
      expect(stored.draftVersionId).toBe(versionId);
      expect(reviews).toBe(0);
      expect(withdrawals).toBe(1);
    } else {
      expect(version.reviewStatus).toBe('APPROVED');
      expect(version.priceTermsVersion).toBe('v1');
      expect(stored.liveVersionId).toBe(versionId);
      expect(stored.draftVersionId).toBeNull();
      expect(reviews).toBe(1);
      expect(withdrawals).toBe(0);
    }
  });
});

describe('kategori bağı submit anında yeniden doğrulanır', () => {
  it('bağ kalkmışsa eski taslak incelemeye gönderilemez', async () => {
    const f = await fixture();
    const card = await createCard(f);

    // Sağlayıcı bu hizmeti profilinden çıkardı.
    await ctx.prisma.providerServiceCategory.deleteMany({
      where: { providerId: f.provider.id, categoryId: f.category.id },
    });

    const response = await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');

    const stored = await ctx.prisma.showcaseCardVersion.findFirstOrThrow({
      where: { cardId: card.id },
    });
    expect(stored.reviewStatus).toBe('DRAFT');
    expect(stored.submittedAt).toBeNull();
  });

  it('bağ kalkmışsa taslak da düzenlenemez', async () => {
    const f = await fixture();
    const card = await createCard(f);

    await ctx.prisma.providerServiceCategory.deleteMany({
      where: { providerId: f.provider.id, categoryId: f.category.id },
    });

    const response = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${card.id}`)
      .set('Cookie', f.providerCookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Yeni başlık' }))
      .expect(400);

    expect(response.body.code).toBe('SHOWCASE_CATEGORY_NOT_OFFERED');
  });

  it('bağ geri gelirse gönderim yeniden mümkün olur', async () => {
    const f = await fixture();
    const card = await createCard(f);

    await ctx.prisma.providerServiceCategory.deleteMany({
      where: { providerId: f.provider.id, categoryId: f.category.id },
    });
    await request(ctx.server)
      .post(`/providers/${f.provider.id}/showcase/cards/${card.id}/submit`)
      .set('Cookie', f.providerCookie)
      .send(SHOWCASE_SUBMIT_BODY)
      .expect(400);

    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: f.provider.id, categoryId: f.category.id },
    });

    const submitted = await submit(f, card.id);
    expect(submitted.draftVersion.reviewStatus).toBe('PENDING');
  });
});
