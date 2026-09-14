import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import { ShowcaseLeadSlaService } from '../src/modules/showcase/showcase-lead-sla.service';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  proveShowcaseLeadPhone,
  resetDatabase,
  showcaseLeadPayload,
  type TestContext,
} from './harness';

/**
 * The deadline, and the one decision that a missed deadline leads to.
 *
 * ## The rule the whole file is about
 *
 * **A breach opens nothing.** The lead does not go to the market, the gate is
 * not cleared, and no other business learns the request exists. The customer
 * wrote to one company; deciding that slowness hands their request to every
 * company in the district is not a decision this application gets to make.
 *
 * `ShowcaseLead_release_needs_decision` says the same thing at the database
 * level, and one case below proves it there — because a rule only the service
 * knows is a rule a future code path can forget.
 *
 * ## Why silence closes the lead rather than releasing it
 *
 * Doing nothing is already an answer. After fourteen days — the same window an
 * approved request gets, deliberately, so there is one window to explain rather
 * than two — the lead closes and the request is cancelled. Never released.
 */
let ctx: TestContext;
let sla: ShowcaseLeadSlaService;

beforeAll(async () => {
  ctx = await createTestApp();
  sla = ctx.app.get(ShowcaseLeadSlaService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

const DAY = 24 * 60 * 60 * 1000;

async function leadScenario() {
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

  const rivalUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const rival = await createDiscoverableProvider(ctx.prisma, {
    userId: rivalUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });

  // A signed-in customer, so the fallback decision has an owner to belong to.
  const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const payload = showcaseLeadPayload(category.slug);
  await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
  const customerCookie = await loginAs(ctx.prisma, customerUser.id);

  const created = await request(ctx.server)
    .post(`/showcase/cards/${card.id}/leads`)
    .set('Cookie', customerCookie)
    .send({ ...payload, useAlternateContact: true });

  expect(created.status).toBe(201);

  const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
  const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

  return {
    category,
    owner,
    ownerCookie: await loginAs(ctx.prisma, ownerUser.id),
    rival,
    rivalCookie: await loginAs(ctx.prisma, rivalUser.id),
    customerCookie,
    adminCookie: await loginAs(ctx.prisma, adminUser.id),
    lead,
  };
}

/** Rewinds a lead's deadline so the sweeper sees it as due. */
async function makeDue(leadId: string) {
  await ctx.prisma.showcaseLead.update({
    where: { id: leadId },
    data: { slaDueAt: new Date(Date.now() - 60_000) },
  });
}

describe('the breach sweeper', () => {
  it('breaches a lead whose deadline has passed and asks the customer', async () => {
    const { lead } = await leadScenario();
    await makeDue(lead.id);

    const result = await sla.execute();

    expect(result.breached).toBe(1);

    const after = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('BREACHED');
    expect(after.breachedAt).not.toBeNull();
    expect(after.fallbackAskedAt).not.toBeNull();
    // Nothing has been released, and nothing has been decided.
    expect(after.releasedAt).toBeNull();
    expect(after.fallbackDecision).toBeNull();

    const gate = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
    });
    // The gate is untouched: a missed deadline opens nothing on its own.
    expect(gate.directShowcaseProviderId).not.toBeNull();

    expect(
      ctx.notifications.sent.filter(
        (message) => message.template === 'showcase-lead-breached-customer',
      ),
    ).toHaveLength(1);
    expect(
      ctx.notifications.sent.filter(
        (message) => message.template === 'showcase-lead-breached-provider',
      ),
    ).toHaveLength(1);
  });

  it('never touches a lead the provider answered in time', async () => {
    const { lead, owner, ownerCookie } = await leadScenario();
    await grantCredits(ctx.prisma, owner.id, 10);

    await request(ctx.server)
      .post(`/providers/${owner.id}/requests/${lead.requestId}/offers`)
      .set('Cookie', ownerCookie)
      .send(offerPayload());

    await makeDue(lead.id);
    const result = await sla.execute();

    // The claim is a conditional UPDATE on `status = 'OPEN'`, so an answered
    // lead matches nothing. The database settles the race, not the ordering of
    // two background jobs.
    expect(result.breached).toBe(0);
    const after = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('ANSWERED');
  });

  it('does nothing on a second pass', async () => {
    const { lead } = await leadScenario();
    await makeDue(lead.id);

    await sla.execute();
    ctx.notifications.clear();
    const second = await sla.execute();

    expect(second.breached).toBe(0);
    // And it does not ask a second time. The question is put once: the
    // fourteen-day timeout already treats silence as an answer.
    expect(
      ctx.notifications.sent.filter(
        (message) => message.template === 'showcase-lead-breached-customer',
      ),
    ).toHaveLength(0);
  });

  it('leaves a lead inside its window alone', async () => {
    await leadScenario();

    const result = await sla.execute();
    expect(result.breached).toBe(0);
  });
});

describe('the customer decides', () => {
  it('RELEASE clears the gate and sends the request to ordinary moderation', async () => {
    const { lead, customerCookie, rival, rivalCookie } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    const response = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' });

    expect(response.status).toBe(200);

    const after = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('RELEASED');
    expect(after.fallbackDecision).toBe('RELEASE');
    expect(after.releasedAt).not.toBeNull();

    const gate = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
    });
    expect(gate.directShowcaseProviderId).toBeNull();
    // Still SUBMITTED: it goes through ordinary moderation before any second
    // business sees it, which is the answer to this flow skipping moderation on
    // the way in.
    expect(gate.status).toBe('SUBMITTED');

    const discovery = await request(ctx.server)
      .get(`/providers/${rival.id}/requests`)
      .set('Cookie', rivalCookie);
    expect(discovery.body).toHaveLength(0);
  });

  it('fans out normally once an operator approves a released request', async () => {
    const { lead, customerCookie, adminCookie, rival, rivalCookie } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' });

    ctx.notifications.clear();

    const approved = await request(ctx.server)
      .patch(`/service-requests/${lead.requestId}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'APPROVED' });
    expect(approved.status).toBe(200);
    // The approval books the fan-out; the sweep delivers it.
    await ctx.app.get(RequestPublishOutbox).deliverPending();

    /*
     * No special case: by the time the gate is clear there is nothing special
     * about this request, and the ordinary fan-out runs — reaching **both**
     * matching businesses, the card's own owner included.
     *
     * That the owner is invited alongside everybody else is the point. A
     * released lead is an ordinary request, and treating its original addressee
     * as still special would be the gate surviving its own removal.
     */
    const invitations = ctx.notifications.sent.filter(
      (message) => message.template === 'request-available',
    );
    expect(invitations).toHaveLength(2);

    const discovery = await request(ctx.server)
      .get(`/providers/${rival.id}/requests`)
      .set('Cookie', rivalCookie);
    expect(discovery.body).toHaveLength(1);
  });

  it('charges the card owner the ordinary price once the lead has been released', async () => {
    const { lead, owner, ownerCookie, customerCookie, adminCookie } = await leadScenario();
    await grantCredits(ctx.prisma, owner.id, 10);
    await makeDue(lead.id);
    await sla.execute();

    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' });

    await request(ctx.server)
      .patch(`/service-requests/${lead.requestId}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'APPROVED' });

    const response = await request(ctx.server)
      .post(`/providers/${owner.id}/requests/${lead.requestId}/offers`)
      .set('Cookie', ownerCookie)
      .send(offerPayload());

    expect(response.status).toBe(201);

    // The free-offer rule reads one column and has no exceptions. Once the gate
    // is clear, everybody pays — the card's own owner included.
    const offer = await ctx.prisma.offer.findFirstOrThrow({});
    expect(offer.entitlementSource).toBe('ONE_TIME_CREDIT');
    expect(offer.creditCost).toBe(2);
  });

  it('KEEP_CLOSED cancels the request and never opens it', async () => {
    const { lead, customerCookie } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    const response = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'KEEP_CLOSED' });

    expect(response.status).toBe(200);

    const after = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('CLOSED_UNANSWERED');
    expect(after.closeReason).toBe('CUSTOMER_KEPT_CLOSED');
    expect(after.releasedAt).toBeNull();

    const gate = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
    });
    expect(gate.status).toBe('CANCELLED');
    // Still set: the record of who this was addressed to survives the closure.
    expect(gate.directShowcaseProviderId).not.toBeNull();
  });

  it('refuses a second decision', async () => {
    const { lead, customerCookie } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' });

    const second = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'KEEP_CLOSED' });

    expect(second.status).toBe(409);
  });

  it('refuses a decision before the deadline has passed', async () => {
    const { lead, customerCookie } = await leadScenario();

    const response = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_FALLBACK_NOT_AVAILABLE');
  });

  it("answers 404 when somebody else's request is addressed", async () => {
    const { lead } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, stranger.id);

    const response = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', cookie)
      .send({ decision: 'RELEASE' });

    // The same 404 as a request that does not exist: a customer probing request
    // ids must not learn which ones are real.
    expect(response.status).toBe(404);
  });

  it('refuses an anonymous decision', async () => {
    const { lead } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    // The one decision in this flow that needs a session: releasing a request
    // to the market is irreversible, and a link that could do it by being
    // clicked would be a decision made by whoever the mail was forwarded to.
    const response = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .send({ decision: 'RELEASE' });

    expect(response.status).toBe(401);
  });
});

describe('the database half of the consent rule', () => {
  it('refuses a releasedAt with no decision behind it', async () => {
    const { lead } = await leadScenario();

    await expect(
      ctx.prisma.showcaseLead.update({
        where: { id: lead.id },
        data: { status: 'RELEASED', releasedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('refuses a releasedAt accompanied by the opposite decision', async () => {
    const { lead } = await leadScenario();
    const now = new Date();

    await expect(
      ctx.prisma.showcaseLead.update({
        where: { id: lead.id },
        data: {
          releasedAt: now,
          fallbackDecision: 'KEEP_CLOSED',
          fallbackDecidedAt: now,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('silence', () => {
  it('closes a breached lead after fourteen days, and never releases it', async () => {
    const { lead } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    await ctx.prisma.showcaseLead.update({
      where: { id: lead.id },
      data: { breachedAt: new Date(Date.now() - 15 * DAY) },
    });

    const result = await sla.execute();

    expect(result.timedOut).toBe(1);

    const after = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('CLOSED_UNANSWERED');
    expect(after.closeReason).toBe('REQUEST_EXPIRED');
    expect(after.releasedAt).toBeNull();
    // Deliberately still NULL: the customer made no decision, and writing one
    // here would put words in their mouth.
    expect(after.fallbackDecision).toBeNull();

    const gate = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
    });
    expect(gate.status).toBe('CANCELLED');
    expect(gate.directShowcaseProviderId).not.toBeNull();
  });

  it('leaves a breached lead alone before the fourteen days are up', async () => {
    const { lead } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    await ctx.prisma.showcaseLead.update({
      where: { id: lead.id },
      data: { breachedAt: new Date(Date.now() - 3 * DAY) },
    });

    const result = await sla.execute();
    expect(result.timedOut).toBe(0);
  });
});

describe('closures driven from the request', () => {
  it('closes the lead when an operator refuses the request', async () => {
    const { lead, adminCookie } = await leadScenario();

    const response = await request(ctx.server)
      .patch(`/service-requests/${lead.requestId}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'REJECTED', rejectionReason: 'Yetersiz bilgi' });

    expect(response.status).toBe(200);

    const after = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    // Otherwise a clock would keep running against a business over something an
    // operator has already refused.
    expect(after.status).toBe('CLOSED_UNANSWERED');
    expect(after.closeReason).toBe('MODERATION_REJECTED');
  });

  it('closes the lead when the customer cancels the request', async () => {
    const { lead, customerCookie } = await leadScenario();

    const response = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/cancel`)
      .set('Cookie', customerCookie)
      .send({});

    expect(response.status).toBe(201);

    const after = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('CLOSED_UNANSWERED');
    expect(after.closeReason).toBe('CUSTOMER_CANCELLED');
  });
});
