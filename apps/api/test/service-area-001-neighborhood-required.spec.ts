import { randomUUID } from 'node:crypto';
import {
  CategoryDeliveryModel,
  MatchRoundStatus,
  RequestDeliveryMode,
  ServiceCategoryKind,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addIsoDays, isoDayToStoredDate, todayIsoDay } from '../src/common/date-only';
import { REQUEST_NEIGHBORHOOD_REQUIRED_CODE } from '../src/common/request-neighborhood-rule';
import { ServiceIssueOutbox } from '../src/modules/notifications/service-issue-outbox.service';
import {
  ACCEPT_OFFER,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  drainBackgroundWork,
  grantCredits,
  loginAs,
  offerPayload,
  proveShowcaseLeadPhone,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  showcaseLeadPayload,
  type TestContext,
} from './harness';

/**
 * SERVICE-AREA-001 — a new ON_SITE request names its neighbourhood.
 *
 * The rule is asked at creation only, on both writers (the marketplace form and
 * the vitrin lead): REMOTE is never asked, and HYBRID is decided by the mode the
 * customer chose. A row already stored without a neighbourhood is a legacy row:
 * approving it, publishing it and reopening it in a later round all keep B-02's
 * district-wide reading, because none of them asks the creation rule again.
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
  // Every case posts several requests from one address.
  resetAuthThrottle(ctx.app);
  ctx.notifications.clear();
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, serviceIssueReportingEnabled: true },
    update: { serviceIssueReportingEnabled: true },
  });
});

const CAFERAGA = { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' };

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

type Party = { id: string; email: string; cookie: string };

async function addProvider(
  categoryId: string,
  areas: Array<{ city: string; district?: string | null; neighborhood?: string | null }>,
): Promise<Party> {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId, areas });
  await grantCredits(ctx.prisma, provider.id, 20);
  return { id: provider.id, email: user.email!, cookie: await loginAs(ctx.prisma, user.id) };
}

function postRequest(body: Record<string, unknown>) {
  return request(ctx.server).post('/service-requests').send(body);
}

async function seeRequest(party: Party, requestId: string) {
  const list = await request(ctx.server)
    .get(`/providers/${party.id}/requests`)
    .set('Cookie', party.cookie)
    .expect(200);
  return (list.body as Array<{ id: string }>).some((row) => row.id === requestId);
}

function invitationsTo(party: Party) {
  return ctx.notifications.sent.filter(
    (message) => message.template === 'request-available' && message.to === party.email,
  ).length;
}

describe('SERVICE-AREA-001 — creation asks for the neighbourhood', () => {
  it('refuses an ON_SITE request without a neighbourhood with its own code, and stores nothing', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');

    for (const neighborhood of [null, '', '   ']) {
      const refused = await postRequest(serviceRequestPayload(category.slug, { neighborhood })).expect(400);
      expect(refused.body).toMatchObject({ code: REQUEST_NEIGHBORHOOD_REQUIRED_CODE, field: 'neighborhood' });
    }

    const { neighborhood: _omitted, ...withoutField } = serviceRequestPayload(category.slug);
    const omitted = await postRequest(withoutField).expect(400);
    expect(omitted.body.code).toBe(REQUEST_NEIGHBORHOOD_REQUIRED_CODE);

    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('accepts an ON_SITE request that names one, stored in its canonical spelling', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const created = await postRequest(
      serviceRequestPayload(category.slug, { neighborhood: 'CAFERAĞA MAH' }),
    ).expect(201);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row).toMatchObject({ deliveryMode: RequestDeliveryMode.ON_SITE, neighborhood: 'Caferağa Mah' });
  });

  it('never asks a REMOTE request', async () => {
    const category = await createCategory(ctx.prisma, 'Online', {
      deliveryModel: CategoryDeliveryModel.REMOTE,
    });
    const created = await postRequest(serviceRequestPayload(category.slug, { neighborhood: null })).expect(201);

    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row).toMatchObject({ deliveryMode: RequestDeliveryMode.REMOTE, neighborhood: null });
  });

  it('lets the HYBRID choice decide: on site is asked, remote is not', async () => {
    const category = await createCategory(ctx.prisma, 'Ders', {
      deliveryModel: CategoryDeliveryModel.HYBRID,
    });

    const onSite = await postRequest(
      serviceRequestPayload(category.slug, { deliveryMode: RequestDeliveryMode.ON_SITE, neighborhood: null }),
    ).expect(400);
    expect(onSite.body.code).toBe(REQUEST_NEIGHBORHOOD_REQUIRED_CODE);

    await postRequest(
      serviceRequestPayload(category.slug, { deliveryMode: RequestDeliveryMode.ON_SITE }),
    ).expect(201);

    const remote = await postRequest(
      serviceRequestPayload(category.slug, { deliveryMode: RequestDeliveryMode.REMOTE, neighborhood: null }),
    ).expect(201);
    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: remote.body.id } })).deliveryMode,
    ).toBe(RequestDeliveryMode.REMOTE);

    // Without a choice the mode is what is missing, and that is what is said.
    const unchosen = await postRequest(serviceRequestPayload(category.slug, { neighborhood: null })).expect(400);
    expect(unchosen.body.code).toBe('DELIVERY_MODE_REQUIRED');
  });

  it('still refuses a neighbourhood that does not belong to the district', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    await postRequest(serviceRequestPayload(category.slug, { neighborhood: 'Bebek Mah' })).expect(400);
  });
});

describe('SERVICE-AREA-001 — the vitrin lead', () => {
  async function liveCard(areas: Array<{ city: string; district?: string | null; neighborhood?: string | null }>) {
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF, offerCreditCost: 2 });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owner = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id, areas });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: owner.id,
      categoryId: category.id,
      areas,
    });
    const pkg = await createShowcasePackage(ctx.prisma);
    await createLiveShowcasePlacement(ctx, { providerId: owner.id, cardId: card.id, versionId: version.id, packageId: pkg.id });
    return { category, card };
  }

  async function postLead(cardId: string, payload: Record<string, unknown>, status: number) {
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    return request(ctx.server).post(`/showcase/cards/${cardId}/leads`).send(payload).expect(status);
  }

  it('asks an on-site lead for its neighbourhood before the shelf, even on a neighbourhood-only card', async () => {
    const { category, card } = await liveCard([CAFERAGA]);

    const refused = await postLead(card.id, showcaseLeadPayload(category.slug, { neighborhood: null }), 400);
    expect(refused.body.code).toBe(REQUEST_NEIGHBORHOOD_REQUIRED_CODE);
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);

    // Naming the card's neighbourhood reaches the neighbourhood shelf.
    await postLead(card.id, showcaseLeadPayload(category.slug, { neighborhood: 'Caferağa Mah' }), 201);
  });

  it('asks it on a district card too, where the shelf alone would have let it through', async () => {
    const { category, card } = await liveCard([{ city: 'İstanbul', district: 'Kadıköy' }]);

    const refused = await postLead(card.id, showcaseLeadPayload(category.slug, { neighborhood: null }), 400);
    expect(refused.body.code).toBe(REQUEST_NEIGHBORHOOD_REQUIRED_CODE);
    await postLead(card.id, showcaseLeadPayload(category.slug), 201);
  });
});

describe('SERVICE-AREA-001 — a legacy request without a neighbourhood keeps B-02', () => {
  /**
   * A request stored before the rule: created as it would be today, then
   * stripped of its neighbourhood while still SUBMITTED — the shape of every
   * row the form produced while the field was optional.
   */
  async function legacySubmittedRequest(categorySlug: string) {
    const created = await postRequest(serviceRequestPayload(categorySlug)).expect(201);
    await ctx.prisma.serviceRequest.update({ where: { id: created.body.id }, data: { neighborhood: null } });
    return created.body.id as string;
  }

  it('is approved, published district-wide, offered on, reopened in Round 2 and published again to the neighbourhood provider', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const caferaga = await addProvider(category.id, [CAFERAGA]);
    const district = await addProvider(category.id, [{ city: 'İstanbul', district: 'Kadıköy' }]);
    const beşiktaş = await addProvider(category.id, [{ city: 'İstanbul', district: 'Beşiktaş' }]);
    const requestId = await legacySubmittedRequest(category.slug);

    // Approval does not ask the creation rule again.
    await request(ctx.server)
      .patch(`/service-requests/${requestId}/status`)
      .set('Cookie', await adminCookie())
      .send({ status: ServiceRequestStatus.APPROVED })
      .expect(200);
    await drainBackgroundWork(ctx.app);

    // Round 1: B-02's district-wide audience, nothing wider.
    expect(await seeRequest(caferaga, requestId)).toBe(true);
    expect(await seeRequest(district, requestId)).toBe(true);
    expect(await seeRequest(beşiktaş, requestId)).toBe(false);
    expect(invitationsTo(caferaga)).toBe(1);
    expect(invitationsTo(beşiktaş)).toBe(0);

    // The district provider wins Round 1 and fails it.
    const offer = await request(ctx.server)
      .post(`/providers/${district.id}/requests/${requestId}/offers`)
      .set('Cookie', district.cookie)
      .send(offerPayload())
      .expect(201);
    const { customerId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
    const customerCookie = await loginAs(ctx.prisma, customerId!);
    await request(ctx.server)
      .post(`/service-requests/${requestId}/offers/${offer.body.id}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);
    // The promised start has passed, so a no-show may be reported.
    await ctx.prisma.offer.update({
      where: { id: offer.body.id },
      data: { estimatedStartDate: isoDayToStoredDate(addIsoDays(todayIsoDay(), -2)) },
    });
    const { currentRoundId } = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { currentRoundId: true },
    });

    const reopened = await request(ctx.server)
      .post(`/service-requests/${requestId}/service-issue`)
      .set('Cookie', customerCookie)
      .send({ roundId: currentRoundId, reason: 'PROVIDER_NO_SHOW', idempotencyKey: randomUUID() })
      .expect(200);
    expect(reopened.body).toMatchObject({
      outcome: 'REOPENED',
      currentRound: { roundNumber: 2, status: MatchRoundStatus.OPEN },
    });
    await ctx.app.get(ServiceIssueOutbox).whenIdle();
    await drainBackgroundWork(ctx.app);

    // Still a legacy row; Round 2 reaches the neighbourhood provider again.
    expect(
      (await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).neighborhood,
    ).toBeNull();
    expect(await seeRequest(caferaga, requestId)).toBe(true);
    expect(await seeRequest(beşiktaş, requestId)).toBe(false);
    expect(invitationsTo(caferaga)).toBe(2);
    expect(invitationsTo(beşiktaş)).toBe(0);

    await request(ctx.server)
      .post(`/providers/${caferaga.id}/requests/${requestId}/offers`)
      .set('Cookie', caferaga.cookie)
      .send(offerPayload())
      .expect(201);
  });
});
