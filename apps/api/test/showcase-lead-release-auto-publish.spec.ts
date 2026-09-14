import { NotificationStatus, ServiceCategoryKind, ServiceRequestStatus, UserRole } from '@prisma/client';
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
  loginAs,
  proveShowcaseLeadPhone,
  resetDatabase,
  showcaseLeadPayload,
  type TestContext,
} from './harness';

/**
 * RELEASE with the marketplace auto-publish switch on.
 *
 * Ordinary RELEASE (the switch off, covered by
 * `showcase-lead-sla-fallback.spec.ts`) clears the gate and leaves the request
 * `SUBMITTED` for an operator. With the switch on, the customer's RELEASE *is*
 * the moderation decision — there is nobody left to moderate it — so the same
 * transaction that clears the gate also publishes the request and books the
 * fan-out.
 */
let ctx: TestContext;
let sla: ShowcaseLeadSlaService;
let outbox: RequestPublishOutbox;

beforeAll(async () => {
  ctx = await createTestApp();
  sla = ctx.app.get(ShowcaseLeadSlaService);
  outbox = ctx.app.get(RequestPublishOutbox);
});

afterAll(async () => {
  // The settings singleton survives resetDatabase; leave the switch off for
  // whichever spec file runs next.
  await setAutoPublish(false);
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  await setAutoPublish(false);
});

async function setAutoPublish(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      unviewedOfferRefundWindowHours: 48,
      marketplaceAutoPublishEnabled: enabled,
    },
    update: { marketplaceAutoPublishEnabled: enabled },
  });
}

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

  return {
    category,
    owner,
    ownerCookie: await loginAs(ctx.prisma, ownerUser.id),
    rival,
    rivalCookie: await loginAs(ctx.prisma, rivalUser.id),
    customerCookie,
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

async function sentRows(requestId: string, template: string) {
  return ctx.prisma.notificationLog.findMany({
    where: { requestId, template, status: NotificationStatus.SENT },
  });
}

describe('RELEASE with marketplace auto-publish', () => {
  it('switch on: RELEASE publishes the request in the same transaction and fans it out', async () => {
    await setAutoPublish(true);
    const { lead, rival, rivalCookie, customerCookie } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    ctx.notifications.clear();

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
    // The gate is clear, and — unlike the switch-off case — the request is
    // already live: nobody is left to moderate it.
    expect(gate.directShowcaseProviderId).toBeNull();
    expect(gate.status).toBe(ServiceRequestStatus.APPROVED);
    expect(gate.approvedAt).not.toBeNull();
    // Nobody moderated it: that pair is how a row says "auto-published".
    expect(gate.moderatedAt).toBeNull();

    // Delivery is deterministic here rather than timing-dependent.
    await outbox.deliverPending();

    expect(await sentRows(lead.requestId, 'request-published')).toHaveLength(1);
    // Both matching businesses hear about it, the card's own owner included —
    // a released lead is an ordinary request from this point on.
    expect(await sentRows(lead.requestId, 'request-available')).toHaveLength(2);

    const discovery = await request(ctx.server)
      .get(`/providers/${rival.id}/requests`)
      .set('Cookie', rivalCookie);
    expect(discovery.body).toHaveLength(1);
  });

  it('switch off: RELEASE leaves the request SUBMITTED and books nothing (unchanged behaviour)', async () => {
    await setAutoPublish(false);
    const { lead, customerCookie } = await leadScenario();
    await makeDue(lead.id);
    await sla.execute();

    ctx.notifications.clear();

    const response = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' });

    expect(response.status).toBe(200);

    const gate = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
    });
    expect(gate.directShowcaseProviderId).toBeNull();
    expect(gate.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(gate.approvedAt).toBeNull();

    await outbox.deliverPending();

    expect(await sentRows(lead.requestId, 'request-published')).toHaveLength(0);
    expect(await sentRows(lead.requestId, 'request-available')).toHaveLength(0);
  });
});
