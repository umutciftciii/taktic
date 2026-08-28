import {
  CreditTransactionType,
  NotificationStatus,
  OfferStatus,
  ProviderStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationMessage } from '../src/modules/notifications/notification.port';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  serviceRequestPayload,
  uniqueSuffix,
  type TestContext,
  ACCEPT_OFFER,
} from './harness';

/**
 * Which message reaches whom, and how many times.
 *
 * The render suite covers what a message looks like; this one covers the part
 * that can leak or duplicate: the recipient, the audience of the fan-out, the
 * once-per-transition guarantee, and the fields that appear only when contact
 * sharing really opened them.
 */

let ctx: TestContext;

const CATEGORY_COST = 2;
const DISCLOSURE_VERSION = 'v1';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  disableContactSharing();
});

afterEach(() => {
  disableContactSharing();
});

function enableContactSharing() {
  process.env.CONTACT_SHARING_ENABLED = 'true';
  process.env.CONTACT_DISCLOSURE_URL = 'https://taktic.example/aydinlatma';
  process.env.CONTACT_DISCLOSURE_VERSION = DISCLOSURE_VERSION;
}

function disableContactSharing() {
  // Explicit rather than deleted: the flag now defaults to on, so removing it
  // would turn "disabled" into "enabled" and quietly invert what these cases
  // assert.
  process.env.CONTACT_SHARING_ENABLED = 'false';
  delete process.env.CONTACT_DISCLOSURE_URL;
  delete process.env.CONTACT_DISCLOSURE_VERSION;
}

function sentTo(template: NotificationMessage['template'], to: string): NotificationMessage[] {
  return ctx.notifications
    .ofTemplate(template)
    .filter((message) => message.to.toLowerCase() === to.toLowerCase());
}

function bodyOf(message: NotificationMessage | undefined): string {
  return JSON.stringify(message?.data ?? {});
}

/** The one message a case expects, or a failure that says so. */
function only(messages: NotificationMessage[]): NotificationMessage {
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

describe('request lifecycle notifications', () => {
  it('mails the receipt to the address on the request and nobody else', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const payload = serviceRequestPayload(category.slug);

    const created = await request(ctx.server).post('/service-requests').send(payload).expect(201);

    const received = ctx.notifications.ofTemplate('request-received');
    expect(received).toHaveLength(1);
    expect(received[0]!.to).toBe(payload.customerEmail);
    expect(received[0]!.data?.requestNumber).toBe(created.body.requestNumber);
    expect(received[0]!.subject).toBe('Talebiniz alındı — inceleniyor');
  });

  it('tells the customer how many providers were really reached, and mails only those', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        customerId: customer.id,
        requestNumber: `TR-FAN-${uniqueSuffix()}`,
        customerName: 'Deniz Yılmaz',
        customerPhone: '05551110000',
        customerEmail: 'deniz@example.test',
        city: 'İstanbul',
        district: 'Kadıköy',
        neighborhood: 'Caferağa',
        addressNote: 'Kapı no 5, zil bozuk',
        status: ServiceRequestStatus.SUBMITTED,
        qualityScore: 82,
      },
    });

    // Matches on category and area.
    const matching = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    // Right category, wrong district.
    const wrongArea = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      district: 'Beşiktaş',
    });
    // Right area, different category.
    const otherCategory = await createCategory(ctx.prisma, 'Boya', { offerCreditCost: 1 });
    const wrongCategory = await createDiscoverableProvider(ctx.prisma, {
      categoryId: otherCategory.id,
    });
    // Matches everything except that the application is not approved.
    const pending = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    await ctx.prisma.providerProfile.update({
      where: { id: pending.id },
      data: { status: ProviderStatus.PENDING_REVIEW },
    });

    const cookie = await adminCookie();
    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', cookie)
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);

    const published = ctx.notifications.ofTemplate('request-published');
    expect(published).toHaveLength(1);
    expect(published[0]!.to).toBe('deniz@example.test');
    expect(published[0]!.data?.reachedProviderCount).toBe('1');

    const invitations = ctx.notifications.ofTemplate('request-available');
    expect(invitations.map((message) => message.to)).toEqual([matching.email]);

    for (const excluded of [wrongArea, wrongCategory, pending]) {
      expect(sentTo('request-available', excluded.email!)).toHaveLength(0);
    }

    // Nothing about where the customer lives beyond the city and district the
    // discovery screen already shows, and nothing about who they are.
    const invitation = bodyOf(invitations[0]!);
    expect(invitation).not.toContain('Caferağa');
    expect(invitation).not.toContain('Kapı no 5');
    expect(invitation).not.toContain('deniz@example.test');
    expect(invitation).not.toContain('05551110000');
    expect(invitation).not.toContain('Deniz Yılmaz');
    expect(invitations[0]!.data?.district).toBe('Kadıköy');
    expect(invitations[0]!.data?.creditCost).toBe(String(CATEGORY_COST));
  });

  it('does not repeat the approval fan-out when the same status is saved again', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const serviceRequest = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        requestNumber: `TR-DUP-${uniqueSuffix()}`,
        customerName: 'Deniz Yılmaz',
        customerPhone: '05551110001',
        customerEmail: 'tekrar@example.test',
        city: 'İstanbul',
        district: 'Kadıköy',
        status: ServiceRequestStatus.SUBMITTED,
      },
    });

    const cookie = await adminCookie();
    const approve = () =>
      request(ctx.server)
        .patch(`/service-requests/${serviceRequest.id}/status`)
        .set('Cookie', cookie)
        .send({ status: ServiceRequestStatus.APPROVED, moderationNote: 'ok' })
        .expect(200);

    await approve();
    await approve();

    expect(ctx.notifications.ofTemplate('request-published')).toHaveLength(1);
    expect(ctx.notifications.ofTemplate('request-available')).toHaveLength(1);
  });
});

describe('offer notifications', () => {
  async function offerFixture() {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
      customerEmail: `owner-${uniqueSuffix()}@example.test`,
    });

    return { category, customer, serviceRequest };
  }

  async function addOffer(categoryId: string, requestId: string) {
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId,
    });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);
    await grantCredits(ctx.prisma, provider.id, 10);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${requestId}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);

    return { ownerUser, provider, cookie, offerId: created.body.id as string };
  }

  it('tells only the request owner that an offer arrived', async () => {
    const { category, serviceRequest } = await offerFixture();
    const other = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: other.id,
      customerEmail: 'baskasi@example.test',
    });

    const { provider } = await addOffer(category.id, serviceRequest.id);

    const messages = ctx.notifications.ofTemplate('offer-received');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toBe(serviceRequest.customerEmail);
    expect(sentTo('offer-received', 'baskasi@example.test')).toHaveLength(0);
    // Only the provider's public business name; nothing from its contact block.
    expect(messages[0]!.data?.providerName).toBe(provider.businessName);
    expect(bodyOf(messages[0]!)).not.toContain(provider.phone);
    expect(bodyOf(messages[0]!)).not.toContain(provider.contactName);
  });

  it('mails both sides of a match and every provider the cascade closed', async () => {
    const { category, customer, serviceRequest } = await offerFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const loser = await addOffer(category.id, serviceRequest.id);
    const withdrawn = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(`/providers/${withdrawn.provider.id}/offers/${withdrawn.offerId}/withdraw`)
      .set('Cookie', withdrawn.cookie)
      .expect(201);

    ctx.notifications.clear();

    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    expect(sentTo('match-customer', serviceRequest.customerEmail!)).toHaveLength(1);
    expect(sentTo('offer-accepted', winner.ownerUser.email!)).toHaveLength(1);
    expect(sentTo('offer-not-selected', loser.ownerUser.email!)).toHaveLength(1);

    // The provider who pulled their own offer is not "not selected".
    expect(sentTo('offer-not-selected', withdrawn.ownerUser.email!)).toHaveLength(0);
    expect(sentTo('offer-accepted', loser.ownerUser.email!)).toHaveLength(0);
    expect(sentTo('match-customer', loser.ownerUser.email!)).toHaveLength(0);
  });

  it('mails a hand-rejected provider once and nobody else', async () => {
    const { category, customer, serviceRequest } = await offerFixture();
    const rejected = await addOffer(category.id, serviceRequest.id);
    const untouched = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${rejected.offerId}/action`)
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);

    expect(sentTo('offer-not-selected', rejected.ownerUser.email!)).toHaveLength(1);
    expect(sentTo('offer-not-selected', untouched.ownerUser.email!)).toHaveLength(0);
  });

  it('says nothing when an offer is only shortlisted', async () => {
    const { category, customer, serviceRequest } = await offerFixture();
    const shortlisted = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${shortlisted.offerId}/action`)
      .set('Cookie', customerCookie)
      .send({ action: 'SHORTLIST' })
      .expect(201);

    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('withholds contact details while contact sharing is off', async () => {
    const { category, customer, serviceRequest } = await offerFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const toCustomer = only(sentTo('match-customer', serviceRequest.customerEmail!));
    expect(toCustomer.data?.contactPhone ?? null).toBeNull();
    expect(toCustomer.data?.contactName ?? null).toBeNull();
    expect(bodyOf(toCustomer)).not.toContain(winner.provider.phone);

    const toProvider = only(sentTo('offer-accepted', winner.ownerUser.email!));
    expect(toProvider.data?.customerPhone ?? null).toBeNull();
    expect(bodyOf(toProvider)).not.toContain(serviceRequest.customerPhone);
    // Still says what the job is worth and where it is.
    expect(toProvider.data?.acceptedAmountMinor).toBe(String(offerPayload().priceAmount));
    expect(toProvider.data?.district).toBe(serviceRequest.district);
  });

  it('carries contact details once the reveal is on file, and never the finer address', async () => {
    enableContactSharing();
    const { category, customer, serviceRequest } = await offerFixture();
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: {
        contactDisclosureVersion: DISCLOSURE_VERSION,
        contactDisclosureAcceptedAt: new Date(),
        neighborhood: 'Caferağa',
        addressNote: 'Kapı no 5',
      },
    });

    const winner = await addOffer(category.id, serviceRequest.id);
    ctx.notifications.clear();

    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    const toCustomer = only(sentTo('match-customer', serviceRequest.customerEmail!));
    expect(toCustomer.data?.contactPhone).toBe(winner.provider.phone);
    expect(toCustomer.data?.contactName).toBe(winner.provider.contactName);

    const toProvider = only(sentTo('offer-accepted', winner.ownerUser.email!));
    expect(toProvider.data?.customerPhone).toBe(serviceRequest.customerPhone);
    expect(toProvider.data?.customerName).toBe(serviceRequest.customerName);
    // The reveal opens a phone number, not a doorstep.
    expect(bodyOf(toProvider)).not.toContain('Caferağa');
    expect(bodyOf(toProvider)).not.toContain('Kapı no 5');
  });
});

describe('provider application notifications', () => {
  it('acknowledges an application once, and announces approval only on a real transition', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);

    const created = await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send({
        businessName: `İşletme ${uniqueSuffix()}`,
        contactName: 'Murat Şahin',
        phone: `0555999${uniqueSuffix().padStart(4, '0')}`,
        email: `basvuru-${uniqueSuffix()}@example.test`,
        city: 'İstanbul',
        district: 'Kadıköy',
        categoryIds: [category.id],
        serviceAreas: [{ city: 'İstanbul', district: 'Kadıköy' }],
      })
      .expect(201);

    const providerId = created.body.id as string;
    const applicationEmail = created.body.email as string;

    // The account's address, not the one typed into the form. This applicant is
    // signed in, so the platform already knows an address that is verifiably
    // theirs; the form field is a business detail they may have mistyped, may
    // not read, and cannot correct by fixing their account. Preferring it is
    // what let a bounced invitation be recorded as a successful send.
    expect(applicationEmail).not.toBe(ownerUser.email);
    expect(sentTo('provider-application-received', ownerUser.email!)).toHaveLength(1);
    expect(sentTo('provider-application-received', applicationEmail)).toHaveLength(0);

    const admin = await adminCookie();
    const approve = () =>
      request(ctx.server)
        .patch(`/providers/${providerId}/status`)
        .set('Cookie', admin)
        .send({ status: ProviderStatus.APPROVED })
        .expect(200);

    await approve();
    await approve();

    expect(sentTo('provider-application-approved', ownerUser.email!)).toHaveLength(1);

    // A suspension and a genuine second approval is a second announcement.
    await request(ctx.server)
      .patch(`/providers/${providerId}/status`)
      .set('Cookie', admin)
      .send({ status: ProviderStatus.SUSPENDED })
      .expect(200);
    await approve();

    expect(sentTo('provider-application-approved', ownerUser.email!)).toHaveLength(2);
  });
});

describe('credit refund notifications', () => {
  it('reports the figures the ledger row actually holds', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
    });
    await grantCredits(ctx.prisma, provider.id, 10);

    const providerCookie = await loginAs(ctx.prisma, ownerUser.id);
    const offer = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', providerCookie)
      .send(offerPayload())
      .expect(201);

    ctx.notifications.clear();

    const admin = await adminCookie();
    await request(ctx.server)
      .post(`/offers/${offer.body.id}/refund-credit`)
      .set('Cookie', admin)
      .send({ reasonCode: 'INVALID_REQUEST', reason: 'Dahili not: müşteri ulaşılamadı', override: true })
      .expect(201);

    const messages = sentTo('credit-refunded', ownerUser.email!);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data?.refundedCredits).toBe(String(CATEGORY_COST));
    expect(messages[0]!.data?.previousBalance).toBe(String(10 - CATEGORY_COST));
    expect(messages[0]!.data?.currentBalance).toBe('10');
    // The label from the closed policy list, never the stored string with the
    // admin's internal note in it.
    expect(messages[0]!.data?.refundReason).toBe('Geçersiz talep');
    expect(bodyOf(messages[0]!)).not.toContain('Dahili not');
  });
});

describe('audit and idempotency', () => {
  it('writes one audit row per message, with the recipient masked', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const payload = serviceRequestPayload(category.slug);
    await request(ctx.server).post('/service-requests').send(payload).expect(201);

    const log = await ctx.prisma.notificationLog.findFirst({
      where: { template: 'request-received' },
    });

    expect(log?.status).toBe(NotificationStatus.SENT);
    expect(log?.maskedRecipient).not.toBe(payload.customerEmail);
    expect(log?.maskedRecipient).toMatch(/^.\*+@/);
    expect(log?.dedupeKey).toMatch(/^request-received:/);
  });

  it('records a transport failure without re-sending it', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const serviceRequest = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        requestNumber: `TR-FAIL-${uniqueSuffix()}`,
        customerName: 'Deniz Yılmaz',
        customerPhone: '05551110002',
        customerEmail: 'hata@example.test',
        city: 'İstanbul',
        district: 'Kadıköy',
        status: ServiceRequestStatus.SUBMITTED,
      },
    });

    const mail = ctx.app.get(TransactionalMailService);
    ctx.notifications.failNextSend = true;
    await mail.sendRequestReceived(serviceRequest.id);

    const failed = await ctx.prisma.notificationLog.findFirst({
      where: { template: 'request-received', requestId: serviceRequest.id },
    });
    expect(failed?.status).toBe(NotificationStatus.FAILED);
    expect(failed?.errorCode).toBe('TRANSPORT_UNAVAILABLE');
    expect(failed?.maskedRecipient).toBe('h***@example.test');

    // The claim stands: a broken transport must not turn into a flood the next
    // time anything touches this request.
    await mail.sendRequestReceived(serviceRequest.id);
    expect(ctx.notifications.ofTemplate('request-received')).toHaveLength(0);
    expect(
      await ctx.prisma.notificationLog.count({
        where: { template: 'request-received', requestId: serviceRequest.id },
      }),
    ).toBe(1);
  });

  it('never stores the body, the subject, the address or a token', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const payload = serviceRequestPayload(category.slug);
    await request(ctx.server).post('/service-requests').send(payload).expect(201);

    const rows = await ctx.prisma.notificationLog.findMany();
    const serialized = JSON.stringify(rows);

    expect(rows.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(payload.customerEmail);
    expect(serialized).not.toContain(payload.customerPhone);
    expect(serialized).not.toContain('Talebiniz alındı');
    expect(serialized).not.toContain('token=');
    expect(serialized).not.toContain('http');
  });

  it('refuses a second message for the same transition even across processes', async () => {
    const provider = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.PENDING_REVIEW,
    });
    const mail = ctx.app.get(TransactionalMailService);

    await mail.sendProviderApplicationReceived(provider.id);
    await mail.sendProviderApplicationReceived(provider.id);

    expect(ctx.notifications.ofTemplate('provider-application-received')).toHaveLength(1);
    expect(
      await ctx.prisma.notificationLog.count({
        where: { template: 'provider-application-received', providerId: provider.id },
      }),
    ).toBe(1);
  });

  it('keeps the snapshot a message was sent with when the source changes afterwards', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
    });
    await grantCredits(ctx.prisma, provider.id, 10);

    await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', await loginAs(ctx.prisma, ownerUser.id))
      .send(offerPayload())
      .expect(201);

    const before = ctx.notifications.lastOfTemplate('offer-received');
    expect(before?.data?.providerName).toBe(provider.businessName);

    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { businessName: 'Sonradan Değişen Ünvan' },
    });

    // The message that already went out still says what it said.
    expect(before?.data?.providerName).toBe(provider.businessName);
    expect(before?.data?.providerName).not.toBe('Sonradan Değişen Ünvan');
  });

  it('counts a refund message against the ledger row rather than the offer', async () => {
    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const grant = await grantCredits(ctx.prisma, provider.id, 5);
    const refund = await ctx.prisma.providerCreditTransaction.create({
      data: {
        providerId: provider.id,
        type: CreditTransactionType.OFFER_REFUND,
        amount: 2,
        balanceAfter: grant.balanceAfter + 2,
        reason: 'NOT_VIEWED_48H: Automatic refund scan',
      },
    });

    const mail = ctx.app.get(TransactionalMailService);
    await mail.sendCreditRefunded(refund.id);
    await mail.sendCreditRefunded(refund.id);

    const messages = ctx.notifications.ofTemplate('credit-refunded');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data?.refundReason).toBe('48 saat içinde görüntülenmedi');
    expect(messages[0]!.data?.currentBalance).toBe(String(grant.balanceAfter + 2));
  });

  it('ignores a transaction that is not a refund', async () => {
    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const grant = await grantCredits(ctx.prisma, provider.id, 5);

    await ctx.app.get(TransactionalMailService).sendCreditRefunded(grant.id);

    expect(ctx.notifications.ofTemplate('credit-refunded')).toHaveLength(0);
  });

  it('does not tell a provider their offer was not selected while it is still open', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
    });
    await grantCredits(ctx.prisma, provider.id, 10);

    const offer = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', await loginAs(ctx.prisma, ownerUser.id))
      .send(offerPayload())
      .expect(201);

    ctx.notifications.clear();

    const mail = ctx.app.get(TransactionalMailService);
    await mail.sendOfferNotSelected([offer.body.id]);
    expect(ctx.notifications.ofTemplate('offer-not-selected')).toHaveLength(0);

    await ctx.prisma.offer.update({
      where: { id: offer.body.id },
      data: { status: OfferStatus.WITHDRAWN, withdrawnAt: new Date() },
    });
    await mail.sendOfferNotSelected([offer.body.id]);
    expect(ctx.notifications.ofTemplate('offer-not-selected')).toHaveLength(0);
  });
});
