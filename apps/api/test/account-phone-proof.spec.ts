import { NotificationStatus, ServiceCategoryKind, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  showcaseLeadPayload,
  type TestContext,
} from './harness';

/**
 * AUTH-PHONE-001 — the account-level proof of a telephone number.
 *
 * A number is proven once, on a request, by the account that owns both. From
 * then on a new request on that same account number is born proven and never
 * asks for a code again — until the number changes, at which point the proof
 * goes with the old number in the same statement. An alternate contact, a
 * guest and a stranger get nothing from it, and nothing about it leaks past
 * the account's own reads.
 */

let ctx: TestContext;
let outbox: RequestPublishOutbox;

const ACCOUNT_PHONE = '05551112233';
const ACCOUNT_PHONE_E164 = '+905551112233';

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(RequestPublishOutbox);
});

afterAll(async () => {
  await setAutoPublish(false);
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  await setAutoPublish(false);
  process.env.REQUIRE_PHONE_VERIFICATION = 'true';
  resetAuthThrottle(ctx.app);
});

afterEach(async () => {
  process.env.REQUIRE_PHONE_VERIFICATION = 'false';
  await outbox.deliverPending();
});

async function setAutoPublish(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, marketplaceAutoPublishEnabled: enabled },
    update: { marketplaceAutoPublishEnabled: enabled },
  });
}

async function sentRows(requestId: string, template: string) {
  return ctx.prisma.notificationLog.findMany({
    where: { requestId, template, status: NotificationStatus.SENT },
  });
}

async function stage() {
  const category = await createCategory(ctx.prisma, 'Klima');
  const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, userId: providerUser.id });
  const customer = await createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    phone: ACCOUNT_PHONE,
    email: 'owner@example.test',
    name: 'Owner',
  });
  const cookie = await loginAs(ctx.prisma, customer.id);
  return { category, customer, cookie, providerUser };
}

/** A request on the account's own contact, as the form posts it for a signed-in customer. */
async function postAccountRequest(cookie: string, categorySlug: string) {
  const res = await request(ctx.server)
    .post('/service-requests')
    .set('Cookie', cookie)
    .send({
      ...serviceRequestPayload(categorySlug),
      customerName: undefined,
      customerPhone: undefined,
      customerEmail: undefined,
    })
    .expect(201);
  return res.body.id as string;
}

async function postAlternateRequest(cookie: string, categorySlug: string, phone: string) {
  const res = await request(ctx.server)
    .post('/service-requests')
    .set('Cookie', cookie)
    .send({ ...serviceRequestPayload(categorySlug), useAlternateContact: true, customerPhone: phone })
    .expect(201);
  return res.body.id as string;
}

async function readMine(cookie: string, id: string) {
  const res = await request(ctx.server).get(`/service-requests/my/${id}`).set('Cookie', cookie).expect(200);
  return res.body as { status: string; phoneVerifiedAt: string | null; awaitingPhoneVerification: boolean };
}

function sendCode(cookie: string, id: string) {
  return request(ctx.server).post(`/service-requests/${id}/phone-verification`).set('Cookie', cookie);
}

async function verifyPhone(cookie: string, id: string) {
  await sendCode(cookie, id).expect(201);
  await request(ctx.server)
    .post(`/service-requests/${id}/phone-verification/verify`)
    .set('Cookie', cookie)
    .send({ code: ctx.sms.lastCode() })
    .expect(201);
}

async function userProof(userId: string) {
  const user = await ctx.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { phone: true, phoneVerifiedAt: true },
  });
  return user;
}

async function markAccountProven(userId: string, at = new Date('2026-09-10T10:00:00.000Z')) {
  await ctx.prisma.user.update({ where: { id: userId }, data: { phoneVerifiedAt: at } });
}

describe('a proven account number', () => {
  it('opens the first and the second request without a code, born APPROVED under instant publish, one fan-out each', async () => {
    await setAutoPublish(true);
    const { category, customer, cookie } = await stage();
    await markAccountProven(customer.id);

    for (const round of [1, 2]) {
      const id = await postAccountRequest(cookie, category.slug);
      const mine = await readMine(cookie, id);
      expect(mine.status, `round ${round}`).toBe(ServiceRequestStatus.APPROVED);
      expect(mine.awaitingPhoneVerification).toBe(false);
      expect(mine.phoneVerifiedAt).not.toBeNull();

      const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
      // Born proven and live at one instant, with no operator's hand on it,
      // and no code of its own: the proof came from the account.
      expect(row.phoneVerifiedAt).toEqual(row.submittedAt);
      expect(row.approvedAt).toEqual(row.submittedAt);
      expect(row.moderatedAt).toBeNull();
      expect(await ctx.prisma.phoneVerification.count({ where: { requestId: id } })).toBe(0);

      // A code cannot even be asked for: the request is already proven.
      await sendCode(cookie, id).expect(409);

      await outbox.deliverPending();
      expect(await sentRows(id, 'request-available')).toHaveLength(1);
      expect(await sentRows(id, 'request-published')).toHaveLength(1);
      expect(ctx.notifications.ofTemplate('request-received')).toHaveLength(0);
    }
  });

  it('with instant publish off, is proven for the operator and waits for the real review', async () => {
    const { category, customer, cookie } = await stage();
    await markAccountProven(customer.id);

    const id = await postAccountRequest(cookie, category.slug);
    const mine = await readMine(cookie, id);
    expect(mine.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(mine.awaitingPhoneVerification).toBe(false);
    expect(mine.phoneVerifiedAt).not.toBeNull();
    expect(ctx.notifications.ofTemplate('request-received')[0]!.data?.nextStep).toBe('review');

    // The operator's approval is not refused by the gate.
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .patch(`/service-requests/${id}/status`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ status: 'APPROVED' })
      .expect(200);
  });

  it('is kept when the profile re-saves the same number in another spelling', async () => {
    const { category, customer, cookie } = await stage();
    await markAccountProven(customer.id);

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Owner', phone: '0555 111 22 33', city: 'İstanbul' })
      .expect(200);

    const user = await userProof(customer.id);
    expect(user.phone).toBe(ACCOUNT_PHONE_E164);
    expect(user.phoneVerifiedAt).not.toBeNull();

    const id = await postAccountRequest(cookie, category.slug);
    expect((await readMine(cookie, id)).awaitingPhoneVerification).toBe(false);
  });

  it('is cleared in the same statement that changes the number, and the next request asks again', async () => {
    await setAutoPublish(true);
    const { category, customer, cookie } = await stage();
    await markAccountProven(customer.id);

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Owner', phone: '05559998877', city: 'İstanbul' })
      .expect(200);

    const user = await userProof(customer.id);
    expect(user.phone).toBe('+905559998877');
    expect(user.phoneVerifiedAt).toBeNull();

    const id = await postAccountRequest(cookie, category.slug);
    const mine = await readMine(cookie, id);
    expect(mine.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(mine.awaitingPhoneVerification).toBe(true);
  });

  it('is never used for an alternate contact person, whose request keeps its own proof', async () => {
    await setAutoPublish(true);
    const { category, customer, cookie } = await stage();
    await markAccountProven(customer.id);

    const id = await postAlternateRequest(cookie, category.slug, '05557776655');
    const mine = await readMine(cookie, id);
    expect(mine.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(mine.awaitingPhoneVerification).toBe(true);
    expect(mine.phoneVerifiedAt).toBeNull();
  });
});

describe('an unproven account number', () => {
  it('waits on the first request; verifying it stamps the request and the account, and the second request needs no code', async () => {
    await setAutoPublish(true);
    const { category, customer, cookie } = await stage();

    const first = await postAccountRequest(cookie, category.slug);
    expect((await readMine(cookie, first)).awaitingPhoneVerification).toBe(true);
    expect((await userProof(customer.id)).phoneVerifiedAt).toBeNull();

    await verifyPhone(cookie, first);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: first } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    const user = await userProof(customer.id);
    expect(user.phoneVerifiedAt).toEqual(row.phoneVerifiedAt);

    const second = await postAccountRequest(cookie, category.slug);
    const mine = await readMine(cookie, second);
    expect(mine.status).toBe(ServiceRequestStatus.APPROVED);
    expect(mine.awaitingPhoneVerification).toBe(false);
    expect(await ctx.prisma.phoneVerification.count({ where: { requestId: second } })).toBe(0);

    await outbox.deliverPending();
    expect(await sentRows(first, 'request-published')).toHaveLength(1);
    expect(await sentRows(second, 'request-published')).toHaveLength(1);
  });

  it('is not promoted by verifying an alternate contact’s number on the account’s request', async () => {
    const { category, customer, cookie } = await stage();

    const id = await postAlternateRequest(cookie, category.slug, '05557776655');
    await verifyPhone(cookie, id);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
    expect(row.phoneVerifiedAt).not.toBeNull();
    expect((await userProof(customer.id)).phoneVerifiedAt).toBeNull();

    // And the account's own number still has to be proven on its own request.
    const own = await postAccountRequest(cookie, category.slug);
    expect((await readMine(cookie, own)).awaitingPhoneVerification).toBe(true);
  });

  it('is not promoted when an operator enters the code on the customer’s behalf', async () => {
    const { category, customer, cookie } = await stage();
    const id = await postAccountRequest(cookie, category.slug);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await sendCode(adminCookie, id).expect(201);
    await request(ctx.server)
      .post(`/service-requests/${id}/phone-verification/verify`)
      .set('Cookie', adminCookie)
      .send({ code: ctx.sms.lastCode() })
      .expect(201);

    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id } })).phoneVerifiedAt).not.toBeNull();
    expect((await userProof(customer.id)).phoneVerifiedAt).toBeNull();
  });
});

describe('races', () => {
  it('a number changed while its code is being verified never inherits the old proof', async () => {
    await setAutoPublish(true);
    const { category, customer, cookie } = await stage();
    const id = await postAccountRequest(cookie, category.slug);
    await sendCode(cookie, id).expect(201);
    const code = ctx.sms.lastCode();

    const [verify, profile] = await Promise.all([
      request(ctx.server).post(`/service-requests/${id}/phone-verification/verify`).set('Cookie', cookie).send({ code }),
      request(ctx.server)
        .patch('/account/profile')
        .set('Cookie', cookie)
        .send({ name: 'Owner', phone: '05559998877', city: 'İstanbul' }),
    ]);
    expect(verify.status).toBe(201);
    expect(profile.status).toBe(200);

    // Whichever committed first: the request is proven and live, and the new
    // number carries no proof.
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    const user = await userProof(customer.id);
    expect(user.phone).toBe('+905559998877');
    expect(user.phoneVerifiedAt).toBeNull();

    const next = await postAccountRequest(cookie, category.slug);
    expect((await readMine(cookie, next)).awaitingPhoneVerification).toBe(true);
  });

  it('two verifications of one code publish once, fan out once and promote once', async () => {
    await setAutoPublish(true);
    const { category, customer, cookie } = await stage();
    const id = await postAccountRequest(cookie, category.slug);
    await sendCode(cookie, id).expect(201);
    const code = ctx.sms.lastCode();

    const results = await Promise.all(
      [0, 1].map(() =>
        request(ctx.server).post(`/service-requests/${id}/phone-verification/verify`).set('Cookie', cookie).send({ code }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);

    await outbox.deliverPending();
    await outbox.deliverPending();
    expect(await sentRows(id, 'request-available')).toHaveLength(1);
    expect(await sentRows(id, 'request-published')).toHaveLength(1);
    expect(
      await ctx.prisma.notificationLog.count({
        where: { requestId: id, template: { in: ['request-available', 'request-published'] } },
      }),
    ).toBe(2);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
    expect((await userProof(customer.id)).phoneVerifiedAt).toEqual(row.phoneVerifiedAt);
  });
});

describe('who can see or use it', () => {
  it('a guest, another customer, a provider and an admin get nothing from the account proof and read nothing of it', async () => {
    await setAutoPublish(true);
    const { category, customer, cookie, providerUser } = await stage();
    await markAccountProven(customer.id);

    // A guest posting the very same number: no session, no account proof —
    // the identity gate refuses the number as belonging to an account.
    await request(ctx.server)
      .post('/service-requests')
      .send({ ...serviceRequestPayload(category.slug), customerPhone: ACCOUNT_PHONE })
      .expect(409);

    // Another customer's request on their own (unproven) number waits.
    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05553334455' });
    const otherCookie = await loginAs(ctx.prisma, other.id);
    const theirs = await postAccountRequest(otherCookie, category.slug);
    expect((await readMine(otherCookie, theirs)).awaitingPhoneVerification).toBe(true);

    // The session read carries the proof only to its own account.
    const me = await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.phoneVerifiedAt).not.toBeNull();
    const otherMe = await request(ctx.server).get('/auth/me').set('Cookie', otherCookie).expect(200);
    expect(otherMe.body.phoneVerifiedAt).toBeNull();

    // Nothing about the account proof on the request the admin or a provider reads.
    const id = await postAccountRequest(cookie, category.slug);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminRead = await request(ctx.server)
      .get(`/service-requests/${id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);
    expect(JSON.stringify(adminRead.body)).not.toContain('awaitingPhoneVerification');
    expect(adminRead.body.customer).not.toHaveProperty('phoneVerifiedAt');
    const providerCookie = await loginAs(ctx.prisma, providerUser.id);
    await request(ctx.server).get(`/service-requests/my/${id}`).set('Cookie', providerCookie).expect(403);
    await request(ctx.server).get(`/service-requests/my/${id}`).expect(401);
  });
});

describe('the vitrin lead', () => {
  async function publishedCard() {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      offerCreditCost: 2,
    });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owner = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: owner.id,
      categoryId: category.id,
    });
    const pkg = await createShowcasePackage(ctx.prisma);
    await createLiveShowcasePlacement(ctx, {
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });
    return { category, card };
  }

  it('opens on a proven account number with no standalone code, and the lead row records the inherited proof', async () => {
    const { category, card } = await publishedCard();
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: ACCOUNT_PHONE,
      email: 'owner@example.test',
      name: 'Owner',
    });
    await markAccountProven(customer.id);
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .set('Cookie', cookie)
      .send({
        ...showcaseLeadPayload(category.slug),
        customerName: undefined,
        customerPhone: undefined,
        customerEmail: undefined,
      });
    expect(response.status).toBe(201);

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: lead.requestId } });
    expect(row.phoneVerifiedAt).toEqual(row.submittedAt);
    expect(await ctx.prisma.phoneVerification.count({ where: { requestId: row.id } })).toBe(0);
  });

  it('still demands the standalone code for an unproven account number and for an alternate contact', async () => {
    const { category, card } = await publishedCard();
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: ACCOUNT_PHONE,
      email: 'owner@example.test',
      name: 'Owner',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const unproven = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .set('Cookie', cookie)
      .send({
        ...showcaseLeadPayload(category.slug),
        customerName: undefined,
        customerPhone: undefined,
        customerEmail: undefined,
      });
    expect(unproven.status).toBe(409);
    expect(unproven.body.code).toBe('SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED');

    await markAccountProven(customer.id);
    const alternate = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .set('Cookie', cookie)
      .send({ ...showcaseLeadPayload(category.slug), useAlternateContact: true, customerPhone: '05557776655' });
    expect(alternate.status).toBe(409);
    expect(alternate.body.code).toBe('SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED');
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
  });
});
