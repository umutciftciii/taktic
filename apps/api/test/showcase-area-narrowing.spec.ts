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
import { classifyShowcaseEdit } from '../src/modules/showcase/showcase-version.rules';
import { showcaseAreaKey } from '../src/common/showcase-area-key';

/**
 * The one exemption from review, and its exact edges.
 *
 * **Removing areas and changing nothing else publishes itself. Everything else
 * waits.** A provider who stops serving a district is making a claim strictly
 * smaller than the one already approved, so there is nothing for an operator to
 * check — but it still changes what is live, so it leaves an audit row naming
 * the provider, both versions and the keys that went away.
 *
 * The cases that would be wrong in opposite directions are both here: an
 * addition that must not slip through because the same edit also removed
 * something, and a content change that must not slip through because the areas
 * happened to shrink.
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

const THREE_AREAS = [
  { city: 'İstanbul', district: 'Kadıköy' },
  { city: 'İstanbul', district: 'Beşiktaş' },
  { city: 'İstanbul', district: 'Üsküdar' },
];

async function approvedCardWithThreeAreas() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: providerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const providerCookie = await loginAs(ctx.prisma, providerUser.id);
  const adminCookie = await loginAs(ctx.prisma, adminUser.id);

  // The card is opened on a right and put on the air by its first approval,
  // so the narrowing cases below act on a card with a real run behind it —
  // which is the state the rule was written for.
  const pkg = await createShowcasePackage(ctx.prisma);
  await createShowcaseEntitlement(ctx, {
    providerId: provider.id,
    userId: providerUser.id,
    packageId: pkg.id,
  });

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/showcase/cards`)
    .set('Cookie', providerCookie)
    .send(showcaseCardPayload(category.id, { areas: THREE_AREAS }))
    .expect(201);

  const submitted = await request(ctx.server)
    .post(`/providers/${provider.id}/showcase/cards/${created.body.id}/submit`)
    .set('Cookie', providerCookie)
    .send(SHOWCASE_SUBMIT_BODY)
    .expect(200);

  await request(ctx.server)
    .post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`)
    .set('Cookie', adminCookie)
    .send({})
    .expect(200);

  const card = await request(ctx.server)
    .get(`/providers/${provider.id}/showcase/cards/${created.body.id}`)
    .set('Cookie', providerCookie)
    .expect(200);

  return { category, provider, providerCookie, adminCookie, card: card.body };
}

/**
 * An edit body whose content is byte-for-byte the live version's.
 *
 * `showcaseCardPayload` gives every card a unique title so fixtures do not
 * collide, which is exactly wrong here: a narrowing is defined as "the areas
 * changed and nothing else did", so a helper that quietly varied the title would
 * make every case in this file a content change and the rule would never be
 * exercised at all.
 */
function sameContentUpdate(
  f: Awaited<ReturnType<typeof approvedCardWithThreeAreas>>,
  overrides: Record<string, unknown> = {},
) {
  const live = f.card.liveVersion;
  return {
    title: live.title,
    summary: live.summary,
    scopeIncluded: live.scopeIncluded,
    scopeExcluded: live.scopeExcluded,
    listedServicePriceAmount: live.listedServicePriceAmount,
    imageUrl: live.imageUrl,
    responseSlaUrgentHours: live.responseSlaUrgentHours,
    responseSlaNormalHours: live.responseSlaNormalHours,
    areas: THREE_AREAS,
    ...overrides,
  };
}

describe('yalnız alan daraltma', () => {
  it('doğrudan yeni canlı sürüm üretir ve incelemeye düşmez', async () => {
    const f = await approvedCardWithThreeAreas();
    const firstVersionId = f.card.liveVersion.id;

    const narrowed = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(
        sameContentUpdate(f, {
          areas: [
            { city: 'İstanbul', district: 'Kadıköy' },
            { city: 'İstanbul', district: 'Beşiktaş' },
          ],
        }),
      )
      .expect(200);

    expect(narrowed.body.status).toBe('APPROVED');
    expect(narrowed.body.draftVersion).toBeNull();
    expect(narrowed.body.liveVersion.id).not.toBe(firstVersionId);
    expect(narrowed.body.liveVersion.versionNumber).toBe(2);
    expect(narrowed.body.liveVersion.reviewStatus).toBe('APPROVED');
    expect(narrowed.body.liveVersion.areas).toHaveLength(2);

    // Hiçbir sürüm inceleme kuyruğuna girmedi.
    const queue = await request(ctx.server)
      .get('/admin/showcase/versions')
      .set('Cookie', f.adminCookie)
      .expect(200);
    expect(queue.body).toHaveLength(0);
  });

  it('operatör kararı gibi sahte bir review satırı yazmaz; audit satırı yazar', async () => {
    const f = await approvedCardWithThreeAreas();
    const firstVersionId = f.card.liveVersion.id;

    const narrowed = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(
        sameContentUpdate(f, {
          areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
        }),
      )
      .expect(200);

    const newVersionId = narrowed.body.liveVersion.id;

    // Otomatik yayımlanan sürümün review satırı YOKTUR — operatör kararı
    // olmayan bir şey, operatör kararı tablosuna yazılmaz.
    const review = await ctx.prisma.showcaseCardReview.findUnique({
      where: { cardVersionId: newVersionId },
    });
    expect(review).toBeNull();

    // Onun yerine denetlenebilir sistem olayı: sağlayıcı kimliği, önceki/yeni
    // sürüm bağı ve düşen alan anahtarları.
    const audit = await ctx.prisma.showcaseCardAutoPublishAudit.findUniqueOrThrow({
      where: { cardVersionId: newVersionId },
    });
    expect(audit.cardId).toBe(f.card.id);
    expect(audit.providerId).toBe(f.provider.id);
    expect(audit.previousVersionId).toBe(firstVersionId);
    expect(audit.removedAreaKeys.sort()).toEqual(
      [
        showcaseAreaKey({ city: 'İstanbul', district: 'Beşiktaş', neighborhood: null }),
        showcaseAreaKey({ city: 'İstanbul', district: 'Üsküdar', neighborhood: null }),
      ].sort(),
    );
  });

  it('daraltılan sürüm, önceki sürümün fiyat sorumluluk kabulünü taşır', async () => {
    const f = await approvedCardWithThreeAreas();
    const previous = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({
      where: { id: f.card.liveVersion.id },
    });

    const narrowed = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(
        sameContentUpdate(f, {
          areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
        }),
      )
      .expect(200);

    expect(narrowed.body.liveVersion.priceTermsVersion).toBe(previous.priceTermsVersion);
    expect(new Date(narrowed.body.liveVersion.priceTermsAcceptedAt).toISOString()).toBe(
      previous.priceTermsAcceptedAt?.toISOString(),
    );
  });

  it('son bölgeyi de silmeye izin vermez', async () => {
    const f = await approvedCardWithThreeAreas();

    await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(sameContentUpdate(f, { areas: [] }))
      .expect(400);
  });
});

describe('alan genişletme ve içerik değişikliği', () => {
  it('alan eklemek incelemeye düşer, canlı sürüm değişmez', async () => {
    const f = await approvedCardWithThreeAreas();
    const liveVersionId = f.card.liveVersion.id;

    const widened = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(
        sameContentUpdate(f, {
          areas: [...THREE_AREAS, { city: 'İstanbul', district: 'Şişli' }],
        }),
      )
      .expect(200);

    expect(widened.body.liveVersion.id).toBe(liveVersionId);
    expect(widened.body.liveVersion.areas).toHaveLength(3);
    expect(widened.body.draftVersion.reviewStatus).toBe('DRAFT');
    expect(widened.body.draftVersion.areas).toHaveLength(4);
  });

  it('aynı düzenlemede hem ekleme hem çıkarma varsa yine incelemeye düşer', async () => {
    const f = await approvedCardWithThreeAreas();
    const liveVersionId = f.card.liveVersion.id;

    // İki bölge çıkıyor, bir bölge ekleniyor: net daralma olsa da eklenen
    // bölge yeni bir iddiadır ve çıkarmalarla "takas" edilemez.
    const mixed = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(
        sameContentUpdate(f, {
          areas: [{ city: 'İstanbul', district: 'Şişli' }],
        }),
      )
      .expect(200);

    expect(mixed.body.liveVersion.id).toBe(liveVersionId);
    expect(mixed.body.draftVersion.reviewStatus).toBe('DRAFT');

    const audits = await ctx.prisma.showcaseCardAutoPublishAudit.count();
    expect(audits).toBe(0);
  });

  it('alan daralsa bile fiyat değişikliği incelemeye düşer', async () => {
    const f = await approvedCardWithThreeAreas();
    const liveVersionId = f.card.liveVersion.id;

    const priced = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(
        sameContentUpdate(f, {
          listedServicePriceAmount: 99000,
          areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
        }),
      )
      .expect(200);

    expect(priced.body.liveVersion.id).toBe(liveVersionId);
    expect(priced.body.liveVersion.listedServicePriceAmount).toBe(150000);
    expect(priced.body.draftVersion.listedServicePriceAmount).toBe(99000);
    expect(await ctx.prisma.showcaseCardAutoPublishAudit.count()).toBe(0);
  });

  it('hiçbir şey değişmeyen kayıt yeni sürüm üretmez', async () => {
    const f = await approvedCardWithThreeAreas();
    const liveVersionId = f.card.liveVersion.id;

    const unchanged = await request(ctx.server)
      .patch(`/providers/${f.provider.id}/showcase/cards/${f.card.id}`)
      .set('Cookie', f.providerCookie)
      .send(sameContentUpdate(f, { areas: THREE_AREAS }))
      .expect(200);

    expect(unchanged.body.liveVersion.id).toBe(liveVersionId);
    expect(unchanged.body.draftVersion).toBeNull();
    expect(await ctx.prisma.showcaseCardVersion.count({ where: { cardId: f.card.id } })).toBe(1);
  });
});

/**
 * The classification rule on its own, without a database.
 *
 * The endpoint cases above prove the rule is wired up; these prove the rule
 * itself, including the shapes that are awkward to build over HTTP — a scope
 * list reordered but not otherwise changed, say.
 */
describe('classifyShowcaseEdit', () => {
  const base = {
    kind: 'SERVICE' as const,
    title: 'Klima bakımı',
    summary: 'Standart kapsamda bakım.',
    scopeIncluded: ['Filtre', 'Gaz kontrolü'],
    scopeExcluded: ['Gaz dolumu'],
    listedServicePriceAmount: 150000,
    listedServiceCurrency: 'TRY',
    imageUrl: null,
    responseSlaUrgentHours: 3,
    responseSlaNormalHours: 24,
  };
  const live = { ...base, areaKeys: ['a|x|', 'b|y|', 'c|z|'] };

  it('daralma AUTO_PUBLISH, düşen anahtarlarla birlikte', () => {
    expect(classifyShowcaseEdit(live, { ...base, areaKeys: ['a|x|'] })).toEqual({
      kind: 'AUTO_PUBLISH',
      removedAreaKeys: ['b|y|', 'c|z|'],
    });
  });

  it('sıra değişikliği alanları etkilemez, aynı küme aynı kümedir', () => {
    expect(classifyShowcaseEdit(live, { ...base, areaKeys: ['c|z|', 'a|x|', 'b|y|'] })).toEqual({
      kind: 'NO_CHANGE',
    });
  });

  it('kapsam listesinin sırası değişirse içerik değişmiştir', () => {
    expect(
      classifyShowcaseEdit(live, {
        ...base,
        scopeIncluded: ['Gaz kontrolü', 'Filtre'],
        areaKeys: ['a|x|'],
      }),
    ).toEqual({ kind: 'REVIEW' });
  });

  it('görsel değişikliği incelemeye düşer', () => {
    expect(
      classifyShowcaseEdit(live, {
        ...base,
        imageUrl: 'https://example.test/yeni.png',
        areaKeys: ['a|x|'],
      }),
    ).toEqual({ kind: 'REVIEW' });
  });

  it('SLA değişikliği incelemeye düşer', () => {
    expect(
      classifyShowcaseEdit(live, { ...base, responseSlaUrgentHours: 1, areaKeys: ['a|x|'] }),
    ).toEqual({ kind: 'REVIEW' });
  });
});
