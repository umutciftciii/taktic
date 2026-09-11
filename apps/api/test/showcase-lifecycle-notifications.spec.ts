import { NotificationStatus, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import { ShowcasePlacementExpiryService } from '../src/modules/showcase/showcase-placement-expiry.service';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
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
 * The vitrin run's life, as the provider hears about it.
 *
 * Every case here is about *which* message goes out and *how many times*:
 * what a message looks like is `transactional-email-render.spec.ts`. The
 * three properties under test are the ones every transactional message in
 * this system shares and each new one has to earn again:
 *
 * 1. **One message per real transition.** An approval that publishes sends
 *    "approved and live" once, not "approved" and then "live". A replayed
 *    settlement, a re-run tick and a repeated clock scan all collide on the
 *    unique index and send nothing.
 * 2. **True when sent.** A reminder is composed from the run's current clock,
 *    so an end the platform moved forward is the end the provider is told.
 * 3. **Nothing about anybody else, and nothing from the payment side.** The
 *    failure notice carries no card, no reason and no code; a configuration
 *    failure that opened no payment page sends nothing at all.
 */
let ctx: TestContext;
let expiry: ShowcasePlacementExpiryService;
let mail: TransactionalMailService;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  ctx = await createTestApp();
  expiry = ctx.app.get(ShowcasePlacementExpiryService);
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

async function scenario(options: { rights?: number; durationDays?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, {
    durationDays: options.durationDays ?? 30,
  });
  for (let i = 0; i < (options.rights ?? 1); i += 1) {
    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
  }
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return {
    category,
    user,
    profile,
    pkg,
    cookie: await loginAs(ctx.prisma, user.id),
    adminCookie: await loginAs(ctx.prisma, admin.id),
  };
}

const createCard = (providerId: string, cookie: string, categoryId: string) =>
  api()
    .post(`/providers/${providerId}/showcase/cards`)
    .set('Cookie', cookie)
    .send(showcaseCardPayload(categoryId));
const submit = (providerId: string, cardId: string, cookie: string) =>
  api().post(`/providers/${providerId}/showcase/cards/${cardId}/submit`).set('Cookie', cookie).send({});
const approve = (versionId: string, cookie: string) =>
  api().post(`/admin/showcase/versions/${versionId}/approve`).set('Cookie', cookie).send({});
const useEntitlement = (providerId: string, cardId: string, cookie: string) =>
  api()
    .post(`/providers/${providerId}/showcase/cards/${cardId}/use-entitlement`)
    .set('Cookie', cookie)
    .send({});

const templatesSent = () => ctx.notifications.sent.map((message) => message.template);

async function logRows(template: string) {
  return ctx.prisma.notificationLog.findMany({
    where: { template },
    orderBy: [{ createdAt: 'asc' }],
  });
}

/** A live run whose end is `hoursLeft` away, with the clock the job reads. */
async function liveRunEndingIn(hoursLeft: number, options: { durationDays?: number } = {}) {
  const { profile, category, pkg, adminCookie, cookie } = await scenario({
    rights: 0,
    durationDays: options.durationDays,
  });
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId: profile.id,
    categoryId: category.id,
    title: 'Klima bakımı',
  });
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: profile.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });
  const endAt = new Date(Date.now() + hoursLeft * HOUR);
  await ctx.prisma.showcasePlacement.update({
    where: { id: placement.id },
    data: { startAt: new Date(endAt.getTime() - (options.durationDays ?? 30) * DAY), endAt },
  });
  return { profile, card, version, placement, adminCookie, cookie };
}

describe('approval', () => {
  it('sends one combined message when the first approval publishes, and only one', async () => {
    const { profile, cookie, adminCookie, category } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const submitted = await submit(profile.id, created.body.id, cookie);
    const versionId = submitted.body.draftVersion.id as string;
    ctx.notifications.clear();

    expect((await approve(versionId, adminCookie)).status).toBe(200);

    expect(templatesSent()).toEqual(['showcase-card-approved-live']);
    const message = ctx.notifications.sent[0]!;
    expect(message.data?.revision).toBe('false');
    expect(message.data?.cardUrl).toContain(`/providers/${profile.id}/vitrin/${created.body.id}`);
    expect(message.data?.endAt).toBeTruthy();

    const rows = await logRows('showcase-card-approved-live');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(`showcase-card-approved-live:${versionId}`);
    expect(rows[0]?.status).toBe(NotificationStatus.SENT);

    // Nothing else about the same event: not "approved", not "live".
    expect(await logRows('showcase-card-approved')).toHaveLength(0);
    expect(await logRows('showcase-placement-activated')).toHaveLength(0);

    // A replayed approval is refused and sends nothing.
    expect((await approve(versionId, adminCookie)).status).toBe(409);
    expect(templatesSent()).toEqual(['showcase-card-approved-live']);

    // The service itself, called again with the same version, is a duplicate.
    await mail.sendShowcaseCardApprovalOutcome(versionId);
    expect(templatesSent()).toEqual(['showcase-card-approved-live']);
    expect(await logRows('showcase-card-approved-live')).toHaveLength(1);
  });

  it('sends "approved" alone when the approval publishes nothing', async () => {
    const { profile, cookie, adminCookie, category } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const first = await submit(profile.id, cardId, cookie);
    expect((await approve(first.body.draftVersion.id, adminCookie)).status).toBe(200);

    // The run ends; the card keeps its approved text and nothing is on the air.
    await ctx.prisma.showcasePlacement.updateMany({
      where: { cardId },
      data: {
        status: 'EXPIRED',
        startAt: new Date(Date.now() - 2 * DAY),
        endAt: new Date(Date.now() - DAY),
      },
    });

    await api()
      .patch(`/providers/${profile.id}/showcase/cards/${cardId}`)
      .set('Cookie', cookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Klima bakımı — güncellendi' }));
    const revision = await submit(profile.id, cardId, cookie);
    const revisionId = revision.body.draftVersion.id as string;
    ctx.notifications.clear();

    expect((await approve(revisionId, adminCookie)).status).toBe(200);

    expect(templatesSent()).toEqual(['showcase-card-approved']);
    const rows = await logRows('showcase-card-approved');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(`showcase-card-approved:${revisionId}`);
    // The first approval's combined notice is the only one of its kind: the
    // revision produced no second one.
    expect(
      await ctx.prisma.notificationLog.count({
        where: { template: 'showcase-card-approved-live' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.notificationLog.count({
        where: { dedupeKey: `showcase-card-approved-live:${revisionId}` },
      }),
    ).toBe(0);
  });

  it('reads as an approved edit when the run was already on the air', async () => {
    const { profile, cookie, adminCookie, category } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const first = await submit(profile.id, cardId, cookie);
    expect((await approve(first.body.draftVersion.id, adminCookie)).status).toBe(200);

    await api()
      .patch(`/providers/${profile.id}/showcase/cards/${cardId}`)
      .set('Cookie', cookie)
      .send(showcaseUpdatePayload(category.id, { title: 'Klima bakımı — güncellendi' }));
    const revision = await submit(profile.id, cardId, cookie);
    ctx.notifications.clear();

    expect((await approve(revision.body.draftVersion.id, adminCookie)).status).toBe(200);

    expect(templatesSent()).toEqual(['showcase-card-approved-live']);
    expect(ctx.notifications.sent[0]?.data?.revision).toBe('true');
    expect(ctx.notifications.sent[0]?.data?.cardTitle).toBe('Klima bakımı — güncellendi');
  });

  it('sends the placement notice, not the approval, when a run goes up later', async () => {
    const { profile, cookie, category, user, pkg } = await scenario({ rights: 0 });
    const { card } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: category.id,
    });
    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    ctx.notifications.clear();

    expect((await useEntitlement(profile.id, card.id, cookie)).status).toBe(201);

    expect(templatesSent()).toEqual(['showcase-placement-activated']);
    const placement = await ctx.prisma.showcasePlacement.findFirstOrThrow({ where: { cardId: card.id } });
    const rows = await logRows('showcase-placement-activated');
    expect(rows[0]?.dedupeKey).toBe(`showcase-placement-activated:${placement.id}`);
    expect(await logRows('showcase-card-approved-live')).toHaveLength(0);
    expect(await logRows('showcase-card-approved')).toHaveLength(0);
  });
});

describe('the run\'s clock', () => {
  it('reminds at seven days, then at three, then says the run ended — each exactly once', async () => {
    const { placement } = await liveRunEndingIn(6 * 24);

    // Seven-day window.
    let result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 1, second: 0 });
    expect(result.notices).toMatchObject({ claimed: 1, sent: 1, failed: 0, unavailable: 0 });
    expect(templatesSent()).toEqual(['showcase-placement-ending-7d']);
    const seven = await logRows('showcase-placement-ending-7d');
    expect(seven).toHaveLength(1);
    expect(seven[0]).toMatchObject({
      dedupeKey: `showcase-placement-ending-7d:${placement.id}`,
      status: NotificationStatus.SENT,
      attemptCount: 1,
      providerId: placement.providerId,
    });

    // A second tick in the same window writes nothing and sends nothing.
    result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 0, second: 0 });
    expect(result.notices.claimed).toBe(0);
    expect(templatesSent()).toEqual(['showcase-placement-ending-7d']);

    // Three-day window.
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { endAt: new Date(Date.now() + 2 * DAY) },
    });
    result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 0, second: 1 });
    expect(templatesSent()).toEqual([
      'showcase-placement-ending-7d',
      'showcase-placement-ending-3d',
    ]);
    await expiry.execute();
    expect(await logRows('showcase-placement-ending-3d')).toHaveLength(1);

    // The end. The intent is written by the expiring transaction and
    // delivered by the same tick.
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { endAt: new Date(Date.now() - HOUR) },
    });
    result = await expiry.execute();
    expect(result.expired).toBe(1);
    expect(result.notices).toMatchObject({ claimed: 1, sent: 1 });
    expect(templatesSent()).toEqual([
      'showcase-placement-ending-7d',
      'showcase-placement-ending-3d',
      'showcase-placement-expired',
    ]);
    const ended = await logRows('showcase-placement-expired');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.dedupeKey).toBe(`showcase-placement-expired:${placement.id}`);

    // Nothing more, however many ticks follow.
    await expiry.execute();
    await expiry.execute();
    expect(ctx.notifications.sent).toHaveLength(3);
    expect(await ctx.prisma.notificationLog.count()).toBe(3);
  });

  it('sends only the three-day notice to a run that reaches that window without the seven-day one', async () => {
    await liveRunEndingIn(2 * 24);

    const result = await expiry.execute();

    expect(result.remindersEnqueued).toEqual({ first: 0, second: 1 });
    expect(templatesSent()).toEqual(['showcase-placement-ending-3d']);
  });

  it('does not remind a short run of a window it never had', async () => {
    // A five-day package: on its first tick the end is within seven days.
    await liveRunEndingIn(5 * 24, { durationDays: 5 });

    const result = await expiry.execute();

    expect(result.remindersEnqueued).toEqual({ first: 0, second: 0 });
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('sends no reminder to a run that is suspended, expired or already ended', async () => {
    const { placement } = await liveRunEndingIn(5 * 24);
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendReason: 'ADMIN_ACTION' },
    });

    let result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 0, second: 0 });

    // An expired row is not on the air either, whatever its end date says.
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { status: 'EXPIRED', suspendedAt: null, suspendReason: null },
    });
    result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 0, second: 0 });
    // And a row expired by hand — not by this job — is not told it ended
    // either: the intent is written only by the transition that ends it.
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('reminds against the extended end after a suspension that stopped the clock', async () => {
    const { placement, adminCookie } = await liveRunEndingIn(5 * 24);

    // The platform pulls the card while its end is inside the seven-day
    // window. The clock stops: no reminder is owed for an end that is going
    // to move.
    const suspended = await api()
      .post(`/admin/showcase/cards/${placement.cardId}/suspend`)
      .set('Cookie', adminCookie)
      .send({ note: 'İnceleme' });
    expect(suspended.status).toBe(200);
    expect(
      (await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placement.id } })).status,
    ).toBe('SUSPENDED');

    let result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 0, second: 0 });
    expect(ctx.notifications.sent).toHaveLength(0);

    // Ten days pass on the shelf; the run is put back and paid those days.
    const startedAt = new Date(Date.now() - 10 * DAY);
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { suspendedAt: startedAt },
    });
    await ctx.prisma.showcasePlacementSuspension.updateMany({
      where: { placementId: placement.id, endedAt: null },
      data: { startedAt },
    });
    const resumed = await api()
      .post(`/admin/showcase/cards/${placement.cardId}/unsuspend`)
      .set('Cookie', adminCookie)
      .send({});
    expect(resumed.status).toBe(200);

    const extended = await ctx.prisma.showcasePlacement.findUniqueOrThrow({
      where: { id: placement.id },
    });
    expect(extended.status).toBe('ACTIVE');
    // Five days were left; ten were given back: about fifteen remain.
    expect(extended.endAt.getTime() - Date.now()).toBeGreaterThan(14 * DAY);

    // Not inside the window any more, so nothing is sent — the reminder waits
    // for the end the run actually has.
    result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 0, second: 0 });
    expect(ctx.notifications.sent).toHaveLength(0);

    // The new end comes into the window: reminded once, and the date in the
    // message is the extended one.
    const newEnd = new Date(Date.now() + 6 * DAY);
    await ctx.prisma.showcasePlacement.update({
      where: { id: placement.id },
      data: { endAt: newEnd },
    });
    result = await expiry.execute();
    expect(result.remindersEnqueued).toEqual({ first: 1, second: 0 });
    expect(templatesSent()).toEqual(['showcase-placement-ending-7d']);
    expect(ctx.notifications.sent[0]?.data?.endAt).toBe(newEnd.toISOString());
  });

  it('composes an intent from the clock at delivery, and settles one that is no longer true', async () => {
    const { placement } = await liveRunEndingIn(6 * 24);

    // An intent written by an earlier tick that never got to send it.
    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: placement.providerId },
      include: { user: true },
    });
    await ctx.prisma.notificationLog.create({
      data: {
        channel: 'EMAIL',
        template: 'showcase-placement-ending-7d',
        maskedRecipient: 'x***@example.test',
        status: NotificationStatus.PENDING,
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `showcase-placement-ending-7d:${placement.id}`,
        attemptCount: 0,
        lastAttemptAt: null,
      },
    });

    // The recorded recipient does not match the provider's real address, so
    // the sweep refuses to guess: FAILED with SOURCE_UNAVAILABLE, never sent
    // to somebody else, and never re-claimed.
    const result = await expiry.execute();
    expect(result.notices).toMatchObject({ claimed: 1, sent: 0, unavailable: 1 });
    expect(ctx.notifications.sent).toHaveLength(0);
    const row = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'showcase-placement-ending-7d' },
    });
    expect(row.status).toBe(NotificationStatus.FAILED);
    expect(row.errorCode).toBe('SOURCE_UNAVAILABLE');

    await expiry.execute();
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('delivers an end-of-run intent a crashed tick left behind, without a second row', async () => {
    const { placement } = await liveRunEndingIn(-1);

    // Simulate the crash: the transition committed with its intent, and the
    // transport was never reached.
    ctx.notifications.failNextSend = false;
    const original = expiry['outbox'].deliverPending.bind(expiry['outbox']);
    expiry['outbox'].deliverPending = async () => ({ claimed: 0, sent: 0, failed: 0, unavailable: 0 });
    try {
      const result = await expiry.execute();
      expect(result.expired).toBe(1);
    } finally {
      expiry['outbox'].deliverPending = original;
    }
    const pending = await logRows('showcase-placement-expired');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: NotificationStatus.PENDING, attemptCount: 0 });
    expect(ctx.notifications.sent).toHaveLength(0);

    // The next tick — with nothing left to expire — delivers it.
    const result = await expiry.execute();
    expect(result.expired).toBe(0);
    expect(result.notices).toMatchObject({ claimed: 1, sent: 1 });
    expect(templatesSent()).toEqual(['showcase-placement-expired']);
    const rows = await logRows('showcase-placement-expired');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: NotificationStatus.SENT,
      attemptCount: 1,
      dedupeKey: `showcase-placement-expired:${placement.id}`,
    });
  });
});

describe('the money', () => {
  it('sends nothing for a purchase that failed before any payment page opened', async () => {
    const { profile, pkg, user } = await scenario({ rights: 0 });
    const acceptance = await ctx.prisma.showcasePackageTermsAcceptance.create({
      data: {
        providerId: profile.id,
        termsVersion: 'v1',
        termsTextSnapshot: 'x',
        acceptedByUserId: user.id,
      },
    });
    const purchase = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: profile.id,
        kind: 'SHOWCASE_PACKAGE',
        showcasePackageId: pkg.id,
        showcasePackageTermsAcceptanceId: acceptance.id,
        durationDaysSnapshot: pkg.durationDays,
        creditAmountSnapshot: 0,
        priceAmountSnapshot: pkg.priceAmount,
        currencySnapshot: pkg.currency,
        packageNameSnapshot: pkg.name,
        paymentProvider: 'lemon-squeezy-test',
        paymentReference: 'ref-not-mapped',
        status: 'FAILED',
        failedAt: new Date(),
        // The checkout never opened: this deployment's mapping is missing.
        paymentFailureCode: 'PACKAGE_NOT_MAPPED',
      },
    });

    await mail.sendShowcasePackagePaymentFailed(purchase.id);

    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await ctx.prisma.notificationLog.count()).toBe(0);
  });

  it('tells the provider once when an operator cancels a pending vitrin checkout', async () => {
    const { profile, pkg, user, adminCookie } = await scenario({ rights: 0 });
    const acceptance = await ctx.prisma.showcasePackageTermsAcceptance.create({
      data: {
        providerId: profile.id,
        termsVersion: 'v1',
        termsTextSnapshot: 'x',
        acceptedByUserId: user.id,
      },
    });
    const purchase = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: profile.id,
        kind: 'SHOWCASE_PACKAGE',
        showcasePackageId: pkg.id,
        showcasePackageTermsAcceptanceId: acceptance.id,
        durationDaysSnapshot: pkg.durationDays,
        creditAmountSnapshot: 0,
        priceAmountSnapshot: pkg.priceAmount,
        currencySnapshot: pkg.currency,
        packageNameSnapshot: pkg.name,
        paymentProvider: 'mock',
        status: 'PENDING',
      },
    });

    const cancelled = await api()
      .patch(`/package-purchases/${purchase.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'CANCELLED', adminNote: 'Yanlış paket seçilmiş' });
    expect(cancelled.status).toBe(200);

    expect(templatesSent()).toEqual(['showcase-package-payment-failed']);
    // The operator's note stays with the operator.
    expect(JSON.stringify(ctx.notifications.sent[0])).not.toContain('Yanlış paket');

    await mail.sendShowcasePackagePaymentFailed(purchase.id);
    expect(ctx.notifications.sent).toHaveLength(1);
    expect(await logRows('showcase-package-payment-failed')).toHaveLength(1);
  });

  it('sends the payment notice once, however many times the settlement is reported', async () => {
    const { profile, user, pkg } = await scenario({ rights: 0 });
    const { purchase } = await createShowcaseEntitlement(ctx, {
      providerId: profile.id,
      userId: user.id,
      packageId: pkg.id,
    });

    await mail.sendShowcasePackagePaymentSucceeded(purchase.id);
    await mail.sendShowcasePackagePaymentSucceeded(purchase.id);

    expect(templatesSent()).toEqual(['showcase-package-payment-succeeded']);
    const message = ctx.notifications.sent[0]!;
    expect(message.data?.packageName).toBe(pkg.name);
    expect(message.data?.priceAmountMinor).toBe(String(pkg.priceAmount));
    expect(message.data?.durationDays).toBe(String(pkg.durationDays));
    expect(message.data?.entitlementExpiresAt).toBeTruthy();
    expect(message.data?.createCardUrl).toContain(`/providers/${profile.id}/vitrin/yeni`);
    const rows = await logRows('showcase-package-payment-succeeded');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(`showcase-package-payment-succeeded:${purchase.id}`);
  });
});
