import { OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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
  ACCEPT_OFFER,
} from './harness';

/**
 * The brief a provider gets once its offer is accepted, and everything that
 * brief is not.
 *
 * A provider that won has to carry the work out, and what the work *is* — the
 * customer's description and the answers to the category's required questions —
 * used to live only on the discovery screen, which stops answering once the
 * request leaves APPROVED. Serving it on the offer instead is a convenience for
 * exactly one provider, so the interesting cases here are the ones that must
 * see nothing: the rival whose offer was closed by the acceptance, the provider
 * still waiting, and the offers list.
 *
 * The other half is what the winner still may not learn. Who the customer is
 * and how to reach them is the contact-sharing flow's decision — its own flag,
 * its own disclosure, its own audit row — and this payload must never become a
 * second, quieter way to answer it. The flag is off on this stack, which is
 * what makes "no contact detail anywhere in the response" a real assertion.
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

const CATEGORY_COST = 2;
const DESCRIPTION = 'Salon klimasının montajı ve ilk bakımı gerekiyor.';
const REQUIRED_ANSWER = 'Duvar tipi, 12000 BTU';
const OPTIONAL_ANSWER = 'Balkondan geçiş var';

/**
 * A priced category with one required and one optional question, a request
 * answering both, and the request approved so providers can offer on it.
 *
 * The request is created through the public endpoint rather than written
 * directly: the answers have to be the ones the API validated and stored, or
 * "only the required ones come back" would be a claim about this file's fixture
 * instead of about the product.
 */
async function approvedRequestWithAnswers() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });

  const requiredQuestion = await ctx.prisma.serviceRequestQuestion.create({
    data: {
      categoryId: category.id,
      key: 'cihaz-tipi',
      label: 'Cihaz tipi ve kapasitesi',
      type: 'TEXT',
      isRequired: true,
      sortOrder: 1,
    },
  });
  const optionalQuestion = await ctx.prisma.serviceRequestQuestion.create({
    data: {
      categoryId: category.id,
      key: 'ek-notlar',
      label: 'Eklemek istedikleriniz',
      type: 'TEXT',
      isRequired: false,
      sortOrder: 2,
    },
  });

  const created = await request(ctx.server)
    .post('/service-requests')
    .send(
      serviceRequestPayload(category.slug, {
        description: DESCRIPTION,
        preferredDate: '2026-09-15',
        urgency: 'THIS_WEEK',
        budgetMin: 150000,
        budgetMax: 300000,
        answers: [
          { questionKey: requiredQuestion.key, value: REQUIRED_ANSWER },
          { questionKey: optionalQuestion.key, value: OPTIONAL_ANSWER },
        ],
      }),
    )
    .expect(201);

  const serviceRequest = await ctx.prisma.serviceRequest.update({
    where: { id: created.body.id as string },
    data: { status: ServiceRequestStatus.APPROVED, approvedAt: new Date() },
  });

  return { category, serviceRequest };
}

/** A funded, discoverable provider with a real offer on the request. */
async function offerOn(categoryId: string, requestId: string) {
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

  return { provider, cookie, offerId: created.body.id as string };
}

async function acceptAsCustomer(requestId: string, offerId: string) {
  const customer = await ctx.prisma.serviceRequest
    .findUniqueOrThrow({ where: { id: requestId }, select: { customerId: true } })
    .then((row) => row.customerId);
  if (!customer) throw new Error('The request has no customer to accept as.');

  const cookie = await loginAs(ctx.prisma, customer);
  await request(ctx.server)
    .post(`/service-requests/${requestId}/offers/${offerId}/action`)
    .set('Cookie', cookie)
    .send(ACCEPT_OFFER)
    .expect(201);
}

function readOffer(providerId: string, offerId: string, cookie: string) {
  return request(ctx.server).get(`/providers/${providerId}/offers/${offerId}`).set('Cookie', cookie);
}

describe('accepted offer work scope', () => {
  it('gives the winning provider the description and the required answers only', async () => {
    const { category, serviceRequest } = await approvedRequestWithAnswers();
    const winner = await offerOn(category.id, serviceRequest.id);

    await acceptAsCustomer(serviceRequest.id, winner.offerId);

    const response = await readOffer(winner.provider.id, winner.offerId, winner.cookie).expect(200);

    expect(response.body.status).toBe(OfferStatus.ACCEPTED);
    expect(response.body.acceptedWorkScope).not.toBeNull();
    expect(response.body.acceptedWorkScope.description).toBe(DESCRIPTION);

    const answers = response.body.acceptedWorkScope.requiredAnswers as Array<{
      questionKey: string;
      questionLabel: string;
      value: unknown;
    }>;
    expect(answers).toHaveLength(1);
    expect(answers[0]?.questionKey).toBe('cihaz-tipi');
    expect(answers[0]?.questionLabel).toBe('Cihaz tipi ve kapasitesi');
    expect(answers[0]?.value).toBe(REQUIRED_ANSWER);

    // The optional answer is the customer's own discretion, not part of the
    // brief — and its absence is what proves the filter is on `isRequired`
    // rather than on "whatever was answered".
    expect(JSON.stringify(response.body)).not.toContain(OPTIONAL_ANSWER);
  });

  it('gives a rival that offered on the same request nothing', async () => {
    const { category, serviceRequest } = await approvedRequestWithAnswers();
    const winner = await offerOn(category.id, serviceRequest.id);
    const rival = await offerOn(category.id, serviceRequest.id);

    await acceptAsCustomer(serviceRequest.id, winner.offerId);

    const response = await readOffer(rival.provider.id, rival.offerId, rival.cookie).expect(200);

    // The acceptance closed this offer; the provider is told the outcome and
    // nothing more — no brief, and still no hint that a rival won.
    expect(response.body.status).toBe(OfferStatus.REJECTED);
    expect(response.body.acceptedWorkScope).toBeNull();

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(DESCRIPTION);
    expect(body).not.toContain(REQUIRED_ANSWER);
    expect(body).not.toContain('COMPETITOR');
  });

  it('gives a provider whose offer is still open nothing', async () => {
    const { category, serviceRequest } = await approvedRequestWithAnswers();
    const waiting = await offerOn(category.id, serviceRequest.id);

    const response = await readOffer(waiting.provider.id, waiting.offerId, waiting.cookie).expect(
      200,
    );

    expect(response.body.status).toBe(OfferStatus.SUBMITTED);
    expect(response.body.acceptedWorkScope).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(DESCRIPTION);
  });

  it('gives a withdrawn offer nothing, even on a request that later matched', async () => {
    const { category, serviceRequest } = await approvedRequestWithAnswers();
    const winner = await offerOn(category.id, serviceRequest.id);
    const leaver = await offerOn(category.id, serviceRequest.id);

    await request(ctx.server)
      .post(`/providers/${leaver.provider.id}/offers/${leaver.offerId}/withdraw`)
      .set('Cookie', leaver.cookie)
      .expect(201);

    await acceptAsCustomer(serviceRequest.id, winner.offerId);

    const response = await readOffer(leaver.provider.id, leaver.offerId, leaver.cookie).expect(200);

    expect(response.body.status).toBe(OfferStatus.WITHDRAWN);
    expect(response.body.acceptedWorkScope).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(DESCRIPTION);
  });

  it('carries no contact detail and no street-level location for the winner', async () => {
    const { category, serviceRequest } = await approvedRequestWithAnswers();
    const winner = await offerOn(category.id, serviceRequest.id);

    // What the customer actually wrote, so the assertions below compare against
    // real values rather than against a shape.
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { neighborhood: 'Caferağa Mah', addressNote: 'Kapı kodu 1234, arka blok' },
    });
    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
      select: { customerName: true, customerPhone: true, customerEmail: true },
    });

    await acceptAsCustomer(serviceRequest.id, winner.offerId);

    const response = await readOffer(winner.provider.id, winner.offerId, winner.cookie).expect(200);
    const body = JSON.stringify(response.body);

    // Contact sharing is off on this stack, so none of this may appear anywhere
    // — and even with it on, this route is not where it would.
    for (const secret of [
      stored.customerName,
      stored.customerPhone,
      stored.customerEmail ?? 'no-email-on-file',
      'Caferağa Mah',
      'Kapı kodu 1234, arka blok',
    ]) {
      expect(body, `the offer payload must not carry "${secret}"`).not.toContain(secret);
    }

    // The location it does carry is the one the offer already quoted.
    expect(response.body.request.city).toBe('İstanbul');
    expect(response.body.request.district).toBe('Kadıköy');
  });

  it('keeps the brief off the offers list', async () => {
    const { category, serviceRequest } = await approvedRequestWithAnswers();
    const winner = await offerOn(category.id, serviceRequest.id);

    await acceptAsCustomer(serviceRequest.id, winner.offerId);

    const response = await request(ctx.server)
      .get(`/providers/${winner.provider.id}/offers`)
      .set('Cookie', winner.cookie)
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].acceptedWorkScope).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(DESCRIPTION);
  });

  it('is refused entirely for a provider the caller does not own', async () => {
    const { category, serviceRequest } = await approvedRequestWithAnswers();
    const winner = await offerOn(category.id, serviceRequest.id);
    const outsider = await offerOn(category.id, serviceRequest.id);

    await acceptAsCustomer(serviceRequest.id, winner.offerId);

    // Unchanged access behaviour: reading somebody else's offer never gets as
    // far as the brief.
    await readOffer(winner.provider.id, winner.offerId, outsider.cookie).expect(403);
  });
});
