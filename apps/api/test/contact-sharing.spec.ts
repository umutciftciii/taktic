import { OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILT_IN_DISCLOSURE_VERSION,
  CONTACT_DISCLOSURE_PATH,
  readContactSharingConfig,
} from '../src/modules/contact-sharing/contact-sharing.config';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  disableContactSharing();
});

afterEach(() => {
  disableContactSharing();
});

const DISCLOSURE_URL = 'https://taktic.example/aydinlatma';
const DISCLOSURE_VERSION = 'v1';
const CATEGORY_COST = 2;

/**
 * The feature is read from the environment on every call, exactly as the phone
 * gate is, so a case can drive both sides without restarting the application.
 */
function enableContactSharing(overrides: { url?: string; version?: string } = {}) {
  process.env.CONTACT_SHARING_ENABLED = 'true';
  process.env.CONTACT_DISCLOSURE_URL = overrides.url ?? DISCLOSURE_URL;
  process.env.CONTACT_DISCLOSURE_VERSION = overrides.version ?? DISCLOSURE_VERSION;
}

function disableContactSharing() {
  // Explicit rather than deleted: the flag now defaults to on, so removing it
  // would turn "disabled" into "enabled" and quietly invert what these cases
  // assert.
  process.env.CONTACT_SHARING_ENABLED = 'false';
  delete process.env.CONTACT_DISCLOSURE_URL;
  delete process.env.CONTACT_DISCLOSURE_VERSION;
}

async function matchingFixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });

  return { category, customer, customerCookie, serviceRequest };
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

/** Records the acceptance the way a request created through the form would. */
async function acceptDisclosure(requestId: string, version = DISCLOSURE_VERSION) {
  await ctx.prisma.serviceRequest.update({
    where: { id: requestId },
    data: { contactDisclosureVersion: version, contactDisclosureAcceptedAt: new Date() },
  });
}

function acceptUrl(requestId: string, offerId: string) {
  return `/service-requests/${requestId}/offers/${offerId}/action`;
}

function customerContactUrl(requestId: string) {
  return `/service-requests/${requestId}/matched-contact`;
}

function providerContactUrl(providerId: string, offerId: string) {
  return `/providers/${providerId}/offers/${offerId}/matched-contact`;
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

describe('contact sharing — configuration', () => {
  it('is on by default, pointing at the disclosure this build serves', () => {
    // Nothing configured at all — the state a fresh deployment is in. Opening
    // the two parties' details is the outcome a match exists to produce, so the
    // default runs the product rather than a version of it with the result
    // switched off.
    delete process.env.CONTACT_SHARING_ENABLED;
    delete process.env.CONTACT_DISCLOSURE_URL;
    delete process.env.CONTACT_DISCLOSURE_VERSION;

    const config = readContactSharingConfig();
    expect(config.enabled).toBe(true);
    expect(config).toMatchObject({
      enabled: true,
      disclosureVersion: BUILT_IN_DISCLOSURE_VERSION,
    });
    // A page this repository serves, so the text a customer confirms cannot be
    // missing: it is in the build.
    expect(config.enabled && config.disclosureUrl).toContain(CONTACT_DISCLOSURE_PATH);
  });

  it('can still be switched off deliberately', () => {
    delete process.env.CONTACT_DISCLOSURE_URL;
    delete process.env.CONTACT_DISCLOSURE_VERSION;
    process.env.CONTACT_SHARING_ENABLED = 'false';
    expect(readContactSharingConfig()).toEqual({ enabled: false });
  });

  it('refuses a half-configured disclosure', () => {
    // Either you use the built-in text or you supply both halves of your own.
    // A version that names no text refers to nothing, and a URL with no version
    // produces acceptances that cannot say what was accepted.
    process.env.CONTACT_SHARING_ENABLED = 'true';
    delete process.env.CONTACT_DISCLOSURE_VERSION;
    process.env.CONTACT_DISCLOSURE_URL = DISCLOSURE_URL;
    expect(() => readContactSharingConfig()).toThrowError(/CONTACT_DISCLOSURE_VERSION is required/);

    delete process.env.CONTACT_DISCLOSURE_URL;
    process.env.CONTACT_DISCLOSURE_VERSION = DISCLOSURE_VERSION;
    expect(() => readContactSharingConfig()).toThrowError(/CONTACT_DISCLOSURE_URL is required/);
  });

  it('refuses a non-https URL and a malformed version', () => {
    enableContactSharing({ url: 'http://taktic.example/aydinlatma' });
    expect(() => readContactSharingConfig()).toThrowError(/must use https/);

    enableContactSharing({ url: 'not-a-url' });
    expect(() => readContactSharingConfig()).toThrowError(/valid absolute URL/);

    enableContactSharing({ version: 'sürüm 1' });
    expect(() => readContactSharingConfig()).toThrowError(/CONTACT_DISCLOSURE_VERSION must be/);

    enableContactSharing({ version: 'a'.repeat(65) });
    expect(() => readContactSharingConfig()).toThrowError(/CONTACT_DISCLOSURE_VERSION must be/);
  });

  it('refuses a flag value that is neither "true" nor "false"', () => {
    process.env.CONTACT_SHARING_ENABLED = 'yes';
    expect(() => readContactSharingConfig()).toThrowError(/must be exactly "true" or "false"/);
  });

  it('normalises the version so two spellings cannot diverge', () => {
    enableContactSharing({ version: 'V1' });
    expect(readContactSharingConfig()).toEqual({
      enabled: true,
      disclosureUrl: `${DISCLOSURE_URL}`,
      disclosureVersion: 'v1',
    });
  });

  it('publishes the disclosure link only while the feature is on', async () => {
    // disableContactSharing() has pinned the flag to false for this case.
    const off = await request(ctx.server).get('/contact-sharing/disclosure').expect(200);
    expect(off.body).toEqual({ enabled: false, disclosureUrl: null, disclosureVersion: null });

    enableContactSharing();
    const on = await request(ctx.server).get('/contact-sharing/disclosure').expect(200);
    expect(on.body).toEqual({
      enabled: true,
      disclosureUrl: DISCLOSURE_URL,
      disclosureVersion: DISCLOSURE_VERSION,
    });
  });
});

describe('contact sharing — off (the shipped default)', () => {
  it('accepts an offer exactly as before, and records no reveal', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.MATCHED);
    expect(stored.matchedOfferId).toBe(winner.offerId);
    expect(stored.contactDisclosureAcceptedAt).toBeNull();
    expect(stored.contactDisclosureVersion).toBeNull();

    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);
  });

  it('creates a request without any disclosure acceptance', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.contactDisclosureAcceptedAt).toBeNull();
    expect(stored.contactDisclosureVersion).toBeNull();
  });

  it('answers every contact endpoint with CONTACT_SHARING_DISABLED', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    const customerView = await request(ctx.server)
      .get(customerContactUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(409);
    expect(customerView.body.code).toBe('CONTACT_SHARING_DISABLED');

    const providerView = await request(ctx.server)
      .get(providerContactUrl(winner.provider.id, winner.offerId))
      .set('Cookie', winner.cookie)
      .expect(409);
    expect(providerView.body.code).toBe('CONTACT_SHARING_DISABLED');

    const adminView = await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/contact-reveal`)
      .set('Cookie', await adminCookie())
      .expect(200);
    expect(adminView.body.enabled).toBe(false);
    expect(adminView.body.contacts).toBeNull();
    expect(adminView.body.event).toBeNull();
  });

  it('leaves the offer projections as narrow as they were', async () => {
    const { category, customerCookie, serviceRequest, customer } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: winner.provider.id },
    });

    await expectNoContactLeak(
      [
        [`/service-requests/${serviceRequest.id}/offers`, customerCookie],
        [`/service-requests/${serviceRequest.id}/offers/${winner.offerId}`, customerCookie],
        [`/providers/${winner.provider.id}/offers`, winner.cookie],
        [`/providers/${winner.provider.id}/offers/${winner.offerId}`, winner.cookie],
      ],
      [stored.customerPhone, stored.customerEmail, provider.phone, provider.email, customer.email],
    );
  });
});

describe('contact sharing — the acknowledgement given at the accept', () => {
  /**
   * The consent the accept screen collects.
   *
   * It belongs here rather than at request creation because this is the moment
   * it is about: submitting a request shares nothing, accepting an offer is what
   * opens both parties' details. A request created before the wording existed —
   * or by a guest form that never showed a box — is therefore still acceptable,
   * and its customer is asked here.
   */
  it('records the acknowledgement and reveals, when the accept carries it', async () => {
    const { category, customer, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    enableContactSharing();

    // Nothing on file: this request was never asked at creation.
    const before = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(before.contactDisclosureAcceptedAt).toBeNull();

    await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({
        action: 'ACCEPT',
        contactDisclosureAccepted: true,
        contactDisclosureVersion: DISCLOSURE_VERSION,
      })
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.MATCHED);
    expect(stored.matchedOfferId).toBe(winner.offerId);
    // Recorded from configuration, never from the client.
    expect(stored.contactDisclosureVersion).toBe(DISCLOSURE_VERSION);
    expect(stored.contactDisclosureAcceptedAt).not.toBeNull();

    const reveal = await ctx.prisma.contactRevealEvent.findUniqueOrThrow({
      where: { requestId: serviceRequest.id },
    });
    expect(reveal.offerId).toBe(winner.offerId);
    expect(reveal.providerId).toBe(winner.provider.id);
    expect(reveal.customerUserId).toBe(customer.id);
    expect(reveal.disclosureVersion).toBe(DISCLOSURE_VERSION);

    // And both sides can now read the other, which is the point of all of it.
    const forCustomer = await request(ctx.server)
      .get(customerContactUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);
    expect(forCustomer.body.provider.businessName).toBeTruthy();
    expect(forCustomer.body.provider.phone).toBeTruthy();

    const forProvider = await request(ctx.server)
      .get(providerContactUrl(winner.provider.id, winner.offerId))
      .set('Cookie', winner.cookie)
      .expect(200);
    expect(forProvider.body.customer.customerPhone).toBe(stored.customerPhone);
  });

  it('refuses an accept that declines the acknowledgement', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    enableContactSharing();

    const response = await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT', contactDisclosureAccepted: false })
      .expect(409);
    expect(response.body.code).toBe('CONTACT_DISCLOSURE_REQUIRED');

    // The accept did not half-happen: no match, no consent on file, no reveal.
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.contactDisclosureAcceptedAt).toBeNull();
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);
  });

  it('refuses an accept that confirms superseded wording', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    enableContactSharing();

    const response = await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({
        action: 'ACCEPT',
        contactDisclosureAccepted: true,
        contactDisclosureVersion: 'v0',
      })
      .expect(409);
    expect(response.body.code).toBe('CONTACT_DISCLOSURE_REQUIRED');
    // Not filed against the current version, which the customer never saw.
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.contactDisclosureAcceptedAt).toBeNull();
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);
  });

  it('accepts on an acknowledgement already on file, without asking twice', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    enableContactSharing();
    await acceptDisclosure(serviceRequest.id);

    await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    expect(await ctx.prisma.contactRevealEvent.count()).toBe(1);
  });

  it('does not let an admin supply the customer\'s acknowledgement', async () => {
    const { category, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    enableContactSharing();
    const admin = await adminCookie();

    // Consent is the customer's to give, and the admin route has nowhere to put
    // it: the status DTO carries a status and nothing else, so an attempt to
    // send one is refused by validation rather than partially honoured.
    await request(ctx.server)
      .patch(`/offers/${winner.offerId}/status`)
      .set('Cookie', admin)
      .send({ status: OfferStatus.ACCEPTED, contactDisclosureAccepted: true })
      .expect(400);

    // And the transition itself runs the same accept, so with nothing on file
    // it is refused rather than matching a request whose customer was never
    // asked.
    const response = await request(ctx.server)
      .patch(`/offers/${winner.offerId}/status`)
      .set('Cookie', admin)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(409);
    expect(response.body.code).toBe('CONTACT_DISCLOSURE_REQUIRED');
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);

    // With the customer's own acceptance on file it goes through.
    await acceptDisclosure(serviceRequest.id);
    await request(ctx.server)
      .patch(`/offers/${winner.offerId}/status`)
      .set('Cookie', admin)
      .send({ status: OfferStatus.ACCEPTED })
      .expect(200);
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(1);
  });
});

describe('contact sharing — on, and what it demands first', () => {
  it('refuses to accept an offer on a request with no disclosure acceptance', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    enableContactSharing();

    const response = await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(409);
    expect(response.body.code).toBe('CONTACT_DISCLOSURE_REQUIRED');

    // Nothing moved: the refusal happens before the first write.
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.matchedOfferId).toBeNull();
    expect(
      (await ctx.prisma.offer.findUniqueOrThrow({ where: { id: winner.offerId } })).status,
    ).toBe(OfferStatus.SUBMITTED);
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);
  });

  it('refuses an acceptance recorded against a superseded version', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    await acceptDisclosure(serviceRequest.id, 'v0');
    enableContactSharing({ version: 'v2' });

    const response = await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(409);
    expect(response.body.code).toBe('CONTACT_DISCLOSURE_REQUIRED');
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);
  });

  it('records an acknowledgement given at creation, and no longer demands one there', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    enableContactSharing();

    // Submitting a request shares nothing, so it no longer refuses one that
    // carries no acknowledgement. The demand moved to the accept, which is the
    // act that actually opens the details — and is covered by the two cases
    // above and the accept-screen case below.
    const plain = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const withoutAcceptance = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: plain.body.id },
    });
    expect(withoutAcceptance.contactDisclosureAcceptedAt).toBeNull();
    expect(withoutAcceptance.contactDisclosureVersion).toBeNull();

    // A form filled in before a version bump is still refused, rather than
    // recorded as an acceptance of text the customer never saw.
    const stale = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          contactDisclosureAccepted: true,
          contactDisclosureVersion: 'v0',
        }),
      )
      .expect(409);
    expect(stale.body.code).toBe('CONTACT_DISCLOSURE_REQUIRED');

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          contactDisclosureAccepted: true,
          contactDisclosureVersion: DISCLOSURE_VERSION,
        }),
      )
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.contactDisclosureVersion).toBe(DISCLOSURE_VERSION);
    expect(stored.contactDisclosureAcceptedAt).not.toBeNull();
    // The stored version comes from configuration, never from the client.
    expect(created.body.contactDisclosureVersion).toBe(DISCLOSURE_VERSION);
  });

  it('writes one complete audit event when the accept succeeds', async () => {
    const { category, customer, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    await acceptDisclosure(serviceRequest.id);
    enableContactSharing();

    const before = Date.now();
    await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    const events = await ctx.prisma.contactRevealEvent.findMany();
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event.requestId).toBe(serviceRequest.id);
    expect(event.offerId).toBe(winner.offerId);
    expect(event.customerUserId).toBe(customer.id);
    expect(event.providerId).toBe(winner.provider.id);
    expect(event.disclosureVersion).toBe(DISCLOSURE_VERSION);
    expect(event.revealedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.matchedOfferId).toBe(event.offerId);
  });

  it('rolls the accept back when the audit row cannot be written', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const winner = await addOffer(category.id, serviceRequest.id);
    const other = await addOffer(category.id, serviceRequest.id);
    await acceptDisclosure(serviceRequest.id);

    // An event already claims this request. The insert inside the accept must
    // fail, and take the whole match down with it.
    await ctx.prisma.contactRevealEvent.create({
      data: {
        requestId: serviceRequest.id,
        offerId: other.offerId,
        providerId: other.provider.id,
        disclosureVersion: DISCLOSURE_VERSION,
      },
    });
    enableContactSharing();

    const response = await request(ctx.server)
      .post(acceptUrl(serviceRequest.id, winner.offerId))
      .set('Cookie', customerCookie)
      .send({ action: 'ACCEPT' });
    expect(response.status).toBe(409);
    expect(response.status).toBeLessThan(500);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.status).toBe(ServiceRequestStatus.APPROVED);
    expect(stored.matchedOfferId).toBeNull();
    expect(stored.matchedAt).toBeNull();

    for (const offer of [winner, other]) {
      expect(
        (await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offer.offerId } })).status,
      ).toBe(OfferStatus.SUBMITTED);
    }

    expect(await ctx.prisma.contactRevealEvent.count()).toBe(1);
  });

  it('creates exactly one event under two parallel accepts', async () => {
    const { category, customerCookie, serviceRequest } = await matchingFixture();
    const first = await addOffer(category.id, serviceRequest.id);
    const second = await addOffer(category.id, serviceRequest.id);
    await acceptDisclosure(serviceRequest.id);
    enableContactSharing();

    const results = await Promise.all([
      request(ctx.server)
        .post(acceptUrl(serviceRequest.id, first.offerId))
        .set('Cookie', customerCookie)
        .send({ action: 'ACCEPT' }),
      request(ctx.server)
        .post(acceptUrl(serviceRequest.id, second.offerId))
        .set('Cookie', customerCookie)
        .send({ action: 'ACCEPT' }),
    ]);

    for (const result of results) {
      expect(result.status).toBeLessThan(500);
    }
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);

    const events = await ctx.prisma.contactRevealEvent.findMany();
    expect(events).toHaveLength(1);

    const accepted = await ctx.prisma.offer.findMany({
      where: { requestId: serviceRequest.id, status: OfferStatus.ACCEPTED },
    });
    expect(accepted).toHaveLength(1);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.matchedOfferId).toBe(accepted[0]!.id);
    expect(events[0]!.offerId).toBe(stored.matchedOfferId);
    expect(events[0]!.providerId).toBe(accepted[0]!.providerId);
  });
});

describe('contact sharing — who may read the details', () => {
  async function matchedFixture() {
    const fixture = await matchingFixture();
    const winner = await addOffer(fixture.category.id, fixture.serviceRequest.id);
    const loser = await addOffer(fixture.category.id, fixture.serviceRequest.id);
    await acceptDisclosure(fixture.serviceRequest.id);
    enableContactSharing();

    await request(ctx.server)
      .post(acceptUrl(fixture.serviceRequest.id, winner.offerId))
      .set('Cookie', fixture.customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    return { ...fixture, winner, loser };
  }

  it('gives the customer the chosen provider, and nothing internal', async () => {
    const { customerCookie, serviceRequest, winner } = await matchedFixture();
    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: winner.provider.id },
    });

    const response = await request(ctx.server)
      .get(customerContactUrl(serviceRequest.id))
      .set('Cookie', customerCookie)
      .expect(200);

    expect(response.body.provider).toEqual({
      id: provider.id,
      businessName: provider.businessName,
      contactName: provider.contactName,
      phone: provider.phone,
      email: provider.email,
      city: provider.city,
      district: provider.district,
    });
    expect(response.body.revealedAt).toBeTruthy();
    expect(response.body.disclosureVersion).toBe(DISCLOSURE_VERSION);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(provider.taxNumber ?? '__no_tax__');
    expect(body).not.toContain('moderationNote');
    expect(body).not.toContain('addressNote');
    expect(body).not.toContain('userId');
  });

  it('gives the chosen provider the customer, and nothing from their account', async () => {
    const { serviceRequest, winner } = await matchedFixture();
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });

    const response = await request(ctx.server)
      .get(providerContactUrl(winner.provider.id, winner.offerId))
      .set('Cookie', winner.cookie)
      .expect(200);

    expect(response.body.customer).toEqual({
      customerName: stored.customerName,
      customerPhone: stored.customerPhone,
      customerEmail: stored.customerEmail,
    });
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
  });

  it('refuses the losing provider, other parties and anonymous callers', async () => {
    const { serviceRequest, winner, loser, category } = await matchedFixture();

    // The losing provider, on its own losing offer.
    await request(ctx.server)
      .get(providerContactUrl(loser.provider.id, loser.offerId))
      .set('Cookie', loser.cookie)
      .expect(404);

    // The losing provider, reaching for the winner's offer.
    await request(ctx.server)
      .get(providerContactUrl(loser.provider.id, winner.offerId))
      .set('Cookie', loser.cookie)
      .expect(404);
    await request(ctx.server)
      .get(providerContactUrl(winner.provider.id, winner.offerId))
      .set('Cookie', loser.cookie)
      .expect(403);

    // An unrelated provider with no offer on this request at all: routed
    // through its own id, so the guard passes and the service still refuses.
    const strangerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const stranger = await createDiscoverableProvider(ctx.prisma, {
      userId: strangerUser.id,
      categoryId: category.id,
    });
    await request(ctx.server)
      .get(providerContactUrl(stranger.id, winner.offerId))
      .set('Cookie', await loginAs(ctx.prisma, strangerUser.id))
      .expect(404);

    // Another customer.
    const otherCustomer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await request(ctx.server)
      .get(customerContactUrl(serviceRequest.id))
      .set('Cookie', await loginAs(ctx.prisma, otherCustomer.id))
      .expect(403);

    // A provider on the customer route, and a customer on the provider route.
    await request(ctx.server)
      .get(customerContactUrl(serviceRequest.id))
      .set('Cookie', winner.cookie)
      .expect(403);

    // Anonymous.
    await request(ctx.server).get(customerContactUrl(serviceRequest.id)).expect(401);
    await request(ctx.server)
      .get(providerContactUrl(winner.provider.id, winner.offerId))
      .expect(401);
  });

  it('refuses a provider whose offer was withdrawn before the match', async () => {
    const fixture = await matchingFixture();
    const winner = await addOffer(fixture.category.id, fixture.serviceRequest.id);
    const quitter = await addOffer(fixture.category.id, fixture.serviceRequest.id);
    await acceptDisclosure(fixture.serviceRequest.id);
    enableContactSharing();

    // Through the real endpoint: a withdrawn offer leaves the running entirely
    // and is not swept into REJECTED by the accept cascade.
    await request(ctx.server)
      .post(`/providers/${quitter.provider.id}/offers/${quitter.offerId}/withdraw`)
      .set('Cookie', quitter.cookie)
      .expect(201);

    await request(ctx.server)
      .post(acceptUrl(fixture.serviceRequest.id, winner.offerId))
      .set('Cookie', fixture.customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    expect(
      (await ctx.prisma.offer.findUniqueOrThrow({ where: { id: quitter.offerId } })).status,
    ).toBe(OfferStatus.WITHDRAWN);

    // The reveal names one offer and one provider. Everybody else is a 404,
    // and the provider who walked away is nobody special.
    await request(ctx.server)
      .get(providerContactUrl(quitter.provider.id, quitter.offerId))
      .set('Cookie', quitter.cookie)
      .expect(404);
    await request(ctx.server)
      .get(providerContactUrl(quitter.provider.id, winner.offerId))
      .set('Cookie', quitter.cookie)
      .expect(404);
  });

  it('refuses a provider whose offer is still pending on a matched request', async () => {
    const fixture = await matchingFixture();
    const winner = await addOffer(fixture.category.id, fixture.serviceRequest.id);
    const waiting = await addOffer(fixture.category.id, fixture.serviceRequest.id);
    await acceptDisclosure(fixture.serviceRequest.id);
    enableContactSharing();

    // Read before the accept, while the request is APPROVED and nothing is
    // open at all: a pending offer is not a match, on its own or later.
    await request(ctx.server)
      .get(providerContactUrl(waiting.provider.id, waiting.offerId))
      .set('Cookie', waiting.cookie)
      .expect(404);

    await request(ctx.server)
      .post(acceptUrl(fixture.serviceRequest.id, winner.offerId))
      .set('Cookie', fixture.customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);

    await request(ctx.server)
      .get(providerContactUrl(waiting.provider.id, waiting.offerId))
      .set('Cookie', waiting.cookie)
      .expect(404);
  });

  it('lets SUPER_ADMIN see both sides with the audit row', async () => {
    const { serviceRequest, winner, customer } = await matchedFixture();

    const response = await request(ctx.server)
      .get(`/service-requests/${serviceRequest.id}/contact-reveal`)
      .set('Cookie', await adminCookie())
      .expect(200);

    expect(response.body.enabled).toBe(true);
    expect(response.body.event.offerId).toBe(winner.offerId);
    expect(response.body.event.providerId).toBe(winner.provider.id);
    expect(response.body.event.customerUserId).toBe(customer.id);
    expect(response.body.event.disclosureVersion).toBe(DISCLOSURE_VERSION);
    expect(response.body.contacts.provider.businessName).toBeTruthy();
    expect(response.body.contacts.customer.customerPhone).toBeTruthy();
  });

  it('discloses nothing for a request that is not matched, or has no event', async () => {
    // Approved, never matched.
    const open = await matchingFixture();
    await addOffer(open.category.id, open.serviceRequest.id);
    enableContactSharing();

    await request(ctx.server)
      .get(customerContactUrl(open.serviceRequest.id))
      .set('Cookie', open.customerCookie)
      .expect(404);

    // Matched while the feature was off, so no event was ever written. Turning
    // the flag on afterwards must not retroactively open those details.
    disableContactSharing();
    const legacy = await matchingFixture();
    const winner = await addOffer(legacy.category.id, legacy.serviceRequest.id);
    await request(ctx.server)
      .post(acceptUrl(legacy.serviceRequest.id, winner.offerId))
      .set('Cookie', legacy.customerCookie)
      .send({ action: 'ACCEPT' })
      .expect(201);
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);

    enableContactSharing();
    await request(ctx.server)
      .get(customerContactUrl(legacy.serviceRequest.id))
      .set('Cookie', legacy.customerCookie)
      .expect(404);
    await request(ctx.server)
      .get(providerContactUrl(winner.provider.id, winner.offerId))
      .set('Cookie', winner.cookie)
      .expect(404);

    const adminView = await request(ctx.server)
      .get(`/service-requests/${legacy.serviceRequest.id}/contact-reveal`)
      .set('Cookie', await adminCookie())
      .expect(200);
    expect(adminView.body.event).toBeNull();
    expect(adminView.body.contacts).toBeNull();
  });

  it('keeps every other projection free of contact details after the reveal', async () => {
    const { customerCookie, serviceRequest, winner, loser, customer } = await matchedFixture();
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: winner.provider.id },
    });

    await expectNoContactLeak(
      [
        [`/service-requests/${serviceRequest.id}/offers`, customerCookie],
        [`/service-requests/${serviceRequest.id}/offers/${winner.offerId}`, customerCookie],
        [`/providers/${winner.provider.id}/offers`, winner.cookie],
        [`/providers/${winner.provider.id}/offers/${winner.offerId}`, winner.cookie],
        [`/providers/${loser.provider.id}/offers/${loser.offerId}`, loser.cookie],
        [`/providers/${loser.provider.id}/requests`, loser.cookie],
      ],
      [stored.customerPhone, stored.customerEmail, provider.phone, provider.email, customer.email],
    );

    // The audit trail names no one either.
    const logs = await request(ctx.server)
      .get('/notification-logs')
      .set('Cookie', await adminCookie())
      .expect(200);
    const logBody = JSON.stringify(logs.body);
    for (const secret of [stored.customerPhone, stored.customerEmail ?? '__none__']) {
      expect(logBody).not.toContain(secret);
    }
    expect(
      await ctx.prisma.notificationLog.count({
        where: { maskedRecipient: { contains: stored.customerPhone } },
      }),
    ).toBe(0);
  });
});

/**
 * Fetches each URL and asserts none of the given values appears anywhere in the
 * response — the blunt version of "these projections stay narrow".
 */
async function expectNoContactLeak(
  targets: Array<[string, string]>,
  secrets: Array<string | null>,
) {
  for (const [url, cookie] of targets) {
    const response = await request(ctx.server).get(url).set('Cookie', cookie).expect(200);
    const body = JSON.stringify(response.body);

    for (const secret of secrets) {
      if (!secret) continue;
      expect(body, `${url} must not disclose ${secret}`).not.toContain(secret);
    }
  }
}
