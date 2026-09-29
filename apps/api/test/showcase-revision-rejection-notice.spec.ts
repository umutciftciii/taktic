import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
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

/**
 * API-HARDENING-001 (2/4): a refused revision of a card with approved text
 * reaches its owner.
 *
 * Before this, the card simply stayed APPROVED: no mail, and the panel's
 * `rejectedVersion` was null whenever a live version existed, so the note an
 * operator wrote for the provider was readable by nobody but operators.
 *
 * - The panel (`rejectedVersion`) now carries the refused revision and its
 *   note until the provider starts a new draft or a later version is approved.
 * - One mail per refused revision, keyed on the version. The note is not in
 *   it — only that a decision exists and where to read it.
 */
let ctx: TestContext;
let mail: TransactionalMailService;

beforeAll(async () => {
  ctx = await createTestApp();
  mail = ctx.app.get(TransactionalMailService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

const api = () => request(ctx.server);
const TEMPLATE = 'showcase-card-revision-rejected';
const NOTE = 'Başlıktaki fiyat ifadesi yanıltıcı; lütfen kaldırın.';

async function liveCardWithPendingRevision() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
  await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const cookie = await loginAs(ctx.prisma, user.id);
  const adminCookie = await loginAs(ctx.prisma, admin.id);

  const created = await api()
    .post(`/providers/${profile.id}/showcase/cards`)
    .set('Cookie', cookie)
    .send(showcaseCardPayload(category.id, { title: 'Klima bakımı' }));
  const cardId = created.body.id as string;
  const first = await api().post(`/providers/${profile.id}/showcase/cards/${cardId}/submit`).set('Cookie', cookie).send({});
  expect(
    (await api().post(`/admin/showcase/versions/${first.body.draftVersion.id}/approve`).set('Cookie', adminCookie).send({}))
      .status,
  ).toBe(200);

  await api()
    .patch(`/providers/${profile.id}/showcase/cards/${cardId}`)
    .set('Cookie', cookie)
    .send(showcaseUpdatePayload(category.id, { title: 'Klima bakımı — sadece 99 TL!' }));
  const revision = await api().post(`/providers/${profile.id}/showcase/cards/${cardId}/submit`).set('Cookie', cookie).send({});
  ctx.notifications.clear();

  return {
    profile,
    category,
    cardId,
    cookie,
    adminCookie,
    liveVersionId: first.body.draftVersion.id as string,
    revisionId: revision.body.draftVersion.id as string,
  };
}

const reject = (versionId: string, cookie: string, note = NOTE) =>
  api().post(`/admin/showcase/versions/${versionId}/reject`).set('Cookie', cookie).send({ note });

const readCard = (providerId: string, cardId: string, cookie: string) =>
  api().get(`/providers/${providerId}/showcase/cards/${cardId}`).set('Cookie', cookie);

describe('a refused revision of a live card', () => {
  it('keeps the card on its approved text, shows the note in the panel, and sends one mail without it', async () => {
    const f = await liveCardWithPendingRevision();

    expect((await reject(f.revisionId, f.adminCookie)).status).toBe(200);

    const card = await readCard(f.profile.id, f.cardId, f.cookie);
    expect(card.body.status).toBe('APPROVED');
    expect(card.body.liveVersion.id).toBe(f.liveVersionId);
    expect(card.body.draftVersion).toBeNull();
    expect(card.body.rejectedVersion.id).toBe(f.revisionId);
    expect(card.body.rejectedVersion.review).toMatchObject({ decision: 'REJECTED', note: NOTE });

    // Still on the air: a refused edit never takes a paid run down.
    const publication = await api()
      .get(`/providers/${f.profile.id}/showcase/publication`)
      .set('Cookie', f.cookie);
    expect(publication.body.cards[0]).toMatchObject({ cardId: f.cardId, state: 'LIVE' });

    expect(ctx.notifications.sent.map((message) => message.template)).toEqual([TEMPLATE]);
    const message = ctx.notifications.sent[0]!;
    expect(message.data).toMatchObject({ cardTitle: 'Klima bakımı' });
    expect(String(message.data?.cardUrl)).toContain(`/providers/${f.profile.id}/vitrin/${f.cardId}`);
    // The operator's free text never reaches a mailbox.
    expect(JSON.stringify(message)).not.toContain('yanıltıcı');

    const rows = await ctx.prisma.notificationLog.findMany({ where: { template: TEMPLATE } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(`${TEMPLATE}:${f.revisionId}`);
  });

  it('answers a repeated rejection with 409 and sends nothing more', async () => {
    const f = await liveCardWithPendingRevision();
    expect((await reject(f.revisionId, f.adminCookie)).status).toBe(200);

    const again = await reject(f.revisionId, f.adminCookie, 'İkinci bir gerekçe daha yazıldı.');

    expect(again.status).toBe(409);
    expect(await ctx.prisma.notificationLog.count({ where: { template: TEMPLATE } })).toBe(1);
    expect(ctx.notifications.sent).toHaveLength(1);
    const review = await ctx.prisma.showcaseCardReview.findUniqueOrThrow({ where: { cardVersionId: f.revisionId } });
    expect(review.note).toBe(NOTE);
  });

  it('lets one of two concurrent rejections win and sends one mail', async () => {
    const f = await liveCardWithPendingRevision();

    const results = await Promise.all([
      reject(f.revisionId, f.adminCookie, 'Birinci operatörün gerekçesi burada.'),
      reject(f.revisionId, f.adminCookie, 'İkinci operatörün gerekçesi burada.'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await ctx.prisma.notificationLog.count({ where: { template: TEMPLATE } })).toBe(1);
    expect(await ctx.prisma.showcaseCardReview.count({ where: { cardVersionId: f.revisionId } })).toBe(1);
  });

  it('sends nothing when the rejection did not happen (the version was approved first)', async () => {
    const f = await liveCardWithPendingRevision();
    expect(
      (await api().post(`/admin/showcase/versions/${f.revisionId}/approve`).set('Cookie', f.adminCookie).send({})).status,
    ).toBe(200);
    ctx.notifications.clear();

    expect((await reject(f.revisionId, f.adminCookie)).status).toBe(409);
    expect(await ctx.prisma.notificationLog.count({ where: { template: TEMPLATE } })).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('stops showing the refusal once the provider starts a new draft, and after a later approval', async () => {
    const f = await liveCardWithPendingRevision();
    await reject(f.revisionId, f.adminCookie);

    const edited = await api()
      .patch(`/providers/${f.profile.id}/showcase/cards/${f.cardId}`)
      .set('Cookie', f.cookie)
      .send(showcaseUpdatePayload(f.category.id, { title: 'Klima bakımı — düzeltildi' }));
    expect(edited.status).toBe(200);
    expect(edited.body.rejectedVersion).toBeNull();

    const resubmitted = await api()
      .post(`/providers/${f.profile.id}/showcase/cards/${f.cardId}/submit`)
      .set('Cookie', f.cookie)
      .send({});
    await api()
      .post(`/admin/showcase/versions/${resubmitted.body.draftVersion.id}/approve`)
      .set('Cookie', f.adminCookie)
      .send({});

    const card = await readCard(f.profile.id, f.cardId, f.cookie);
    expect(card.body.liveVersion.id).toBe(resubmitted.body.draftVersion.id);
    expect(card.body.rejectedVersion).toBeNull();
  });

  it('can be rebuilt for a retry from the version alone, and not for a first-version refusal', async () => {
    const f = await liveCardWithPendingRevision();
    await reject(f.revisionId, f.adminCookie);

    const rebuilt = await mail.composeRetryMessage(TEMPLATE, `${TEMPLATE}:${f.revisionId}`);
    expect(rebuilt?.template).toBe(TEMPLATE);
    expect(JSON.stringify(rebuilt)).not.toContain('yanıltıcı');

    // The live version is not a refused revision: nothing to rebuild.
    expect(await mail.composeRetryMessage(TEMPLATE, `${TEMPLATE}:${f.liveVersionId}`)).toBeNull();
  });
});

describe('a refused first version', () => {
  it('keeps its existing panel state and does not send the revision notice', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const profile = await createDiscoverableProvider(ctx.prisma, {
      userId: user.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, user.id);
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const created = await api()
      .post(`/providers/${profile.id}/showcase/cards`)
      .set('Cookie', cookie)
      .send(showcaseCardPayload(category.id));
    const submitted = await api()
      .post(`/providers/${profile.id}/showcase/cards/${created.body.id}/submit`)
      .set('Cookie', cookie)
      .send({});
    ctx.notifications.clear();

    expect((await reject(submitted.body.draftVersion.id, adminCookie)).status).toBe(200);

    const card = await readCard(profile.id, created.body.id, cookie);
    expect(card.body.status).toBe('REJECTED');
    expect(card.body.rejectedVersion.review.note).toBe(NOTE);
    expect(await ctx.prisma.notificationLog.count({ where: { template: TEMPLATE } })).toBe(0);
  });
});
