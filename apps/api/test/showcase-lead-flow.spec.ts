import { OfferEntitlementSource, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  proveShowcaseLeadPhone,
  resetDatabase,
  showcaseLeadPayload,
  type TestContext,
} from './harness';

/**
 * The direct vitrin lead: a request that reaches exactly one business, with a
 * clock on it.
 *
 * ## The four properties this file exists to hold
 *
 * 1. **Only the card's owner can see it.** Not "sees it first" — nobody else
 *    sees it at all, at any point, until the customer says otherwise. That is
 *    the whole of what a placement sells.
 * 2. **No fan-out.** An ordinary approved request mails every matching
 *    business; this one mails one, and the difference is read off the gate
 *    column rather than off where the request came from.
 * 3. **Answering it is free.** The provider already paid for the placement the
 *    lead arrived through, and charging again would be taking money twice for
 *    one introduction.
 * 4. **The deadline is the card's own promise**, read from the version an
 *    operator approved and frozen — never sent by the client.
 *
 * ## Why phone verification is mandatory here
 *
 * This is the one path to a business's inbox with no operator in between, and
 * the request has to become APPROVED for the provider's own offer to land — a
 * transition that already refuses an unverified number. Opening the lead anyway
 * would start a clock on something that could never progress. So the proof
 * comes *before* the request exists, which is the opposite of every other flow
 * in this product.
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
  ctx.notifications.clear();
});

async function published(
  options: { urgentHours?: number; normalHours?: number; kind?: 'SERVICE' | 'PROMOTION' } = {},
) {
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
    kind: options.kind ?? 'SERVICE',
    responseSlaUrgentHours: options.urgentHours ?? 3,
    responseSlaNormalHours: options.normalHours ?? 24,
  });
  const pkg = await createShowcasePackage(ctx.prisma);
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId: owner.id,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });

  // A second, equally well-matched business. Its whole job is to not see
  // anything.
  const rivalUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const rival = await createDiscoverableProvider(ctx.prisma, {
    userId: rivalUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });

  return {
    category,
    owner,
    ownerCookie: await loginAs(ctx.prisma, ownerUser.id),
    rival,
    rivalCookie: await loginAs(ctx.prisma, rivalUser.id),
    card,
    version,
    placement,
  };
}

/**
 * A second published card for the same business.
 *
 * One card holds one live run, and takes one lead per ten minutes from one
 * person — both by design. So a case that needs several leads from one number
 * needs several cards, exactly as a real customer writing to several businesses
 * would.
 */
async function publishAnotherCard(providerId: string, categoryId: string, title: string) {
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
    providerId,
    categoryId,
    title,
  });
  const pkg = await createShowcasePackage(ctx.prisma);

  await createLiveShowcasePlacement(ctx, {
    providerId,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });

  return card;
}

/** Opens a lead, proving the telephone number first as the real flow does. */
async function openLead(
  cardId: string,
  categorySlug: string,
  overrides: Record<string, unknown> = {},
) {
  const payload = showcaseLeadPayload(categorySlug, overrides);
  await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);

  return request(ctx.server).post(`/showcase/cards/${cardId}/leads`).send(payload);
}

describe('opening a lead', () => {
  it('freezes the urgent promise from the card’s own approved version', async () => {
    const { card, category } = await published({ urgentHours: 3, normalHours: 24 });

    const response = await openLead(card.id, category.slug, { urgencyBucket: 'URGENT' });

    expect(response.status).toBe(201);

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    expect(lead.urgencyBucket).toBe('URGENT');
    expect(lead.slaHoursSnapshot).toBe(3);
    // From `createdAt`, because a direct lead waits for nobody: the card is
    // already approved, so there is no moderation step the clock could start
    // from.
    expect(lead.slaDueAt.getTime() - lead.createdAt.getTime()).toBe(3 * 60 * 60 * 1000);
  });

  it('freezes the normal promise for the normal bucket', async () => {
    const { card, category } = await published({ urgentHours: 2, normalHours: 36 });

    await openLead(card.id, category.slug, { urgencyBucket: 'NORMAL' });

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    expect(lead.slaHoursSnapshot).toBe(36);
  });

  it('ignores an SLA the client tried to set for itself', async () => {
    const { card, category } = await published({ urgentHours: 3 });

    // `forbidNonWhitelisted` refuses the field outright. A client that could
    // name the hours could give itself a one-hour deadline on somebody else's
    // business.
    const payload = showcaseLeadPayload(category.slug, {
      urgencyBucket: 'URGENT',
      slaHours: 1,
    });
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);

    const response = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .send(payload);

    expect(response.status).toBe(400);
  });

  it('resolves the placement itself and refuses one named in the body', async () => {
    const { card, category, placement } = await published();

    const payload = showcaseLeadPayload(category.slug, { placementId: placement.id });
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);

    // The IDOR this endpoint is written around: it needs no session, so a body
    // that could name a run could attach a lead — and its clock — to somebody
    // else's paid placement.
    const response = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .send(payload);

    expect(response.status).toBe(400);
  });

  it('accepts an urgent answer-time choice alongside an unhurried job', async () => {
    const { card, category } = await published();

    // The two are different questions and neither is derived from the other:
    // `urgency` is when the work is wanted, `urgencyBucket` is how long the
    // customer will wait for a reply.
    const response = await openLead(card.id, category.slug, {
      urgencyBucket: 'URGENT',
      urgency: 'önümüzdeki ay',
    });

    expect(response.status).toBe(201);

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({
      include: { request: true },
    });
    expect(lead.urgencyBucket).toBe('URGENT');
    expect(lead.request.urgency).toBe('önümüzdeki ay');
  });

  it('records the price the customer actually read', async () => {
    const { card, category } = await published({ kind: 'SERVICE' });

    await openLead(card.id, category.slug);

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    expect(lead.kindSnapshot).toBe('SERVICE');
    expect(lead.listedPriceSnapshot).toBe(150_000);
  });

  it('records no price for a promotion card, and the database insists', async () => {
    const { card, category } = await published({ kind: 'PROMOTION' });

    await openLead(card.id, category.slug);

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    expect(lead.listedPriceSnapshot).toBeNull();

    await expect(
      ctx.prisma.showcaseLead.update({
        where: { id: lead.id },
        data: { listedPriceSnapshot: 1_000 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a card that is not on the air', async () => {
    const { card, category } = await published();
    await ctx.prisma.showcasePlacement.updateMany({
      where: { cardId: card.id },
      // Both ends move: `ShowcasePlacement_window_ordered` refuses a run that
      // ends before it starts, which is the constraint doing its job.
      data: {
        startAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        endAt: new Date(Date.now() - 60_000),
      },
    });

    const response = await openLead(card.id, category.slug);

    expect(response.status).toBe(404);
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
  });

  /*
   * The gate that replaced the feed's location requirement.
   *
   * A visitor now meets every live card on the home page without naming a
   * place, so the coverage line on a card is an advertisement rather than a
   * filter. These two cases are what stops that being a hole: the address on
   * the request — not the one the card was browsed from — decides, and it is
   * decided on the server.
   */
  it('opens a lead when the address the customer typed is inside the run’s shelf', async () => {
    const { card, category } = await published();

    const response = await openLead(card.id, category.slug, {
      city: 'İstanbul',
      district: 'Kadıköy',
    });

    expect(response.status).toBe(201);
  });

  it('refuses a lead for an address the card does not serve, and opens nothing', async () => {
    const { card, category } = await published();

    const response = await openLead(card.id, category.slug, {
      city: 'İstanbul',
      district: 'Beşiktaş',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_LEAD_AREA_NOT_SERVED');
    // Nothing at all is written: no lead, and no service request behind it —
    // a refusal that left a marketplace request lying around would be the
    // customer's work quietly reaching businesses they never chose.
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('reads the card’s coverage from the shelf, so a wider card still takes the lead', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
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
      areas: [{ city: 'İstanbul', district: null }],
    });
    await createLiveShowcasePlacement(ctx, {
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      packageId: (await createShowcasePackage(ctx.prisma)).id,
    });

    // "İstanbul geneli" covers every district in it — the same containment rule
    // the shelf itself is keyed on, rather than a second implementation of it.
    const response = await openLead(card.id, category.slug, {
      city: 'İstanbul',
      district: 'Beşiktaş',
    });

    expect(response.status).toBe(201);
  });

  it('refuses a provider trying to write to a card', async () => {
    const { card, category, rivalCookie } = await published();
    const payload = showcaseLeadPayload(category.slug);
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);

    const response = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .set('Cookie', rivalCookie)
      .send(payload);

    expect(response.status).toBe(403);
  });
});

describe('the body is the marketplace request body', () => {
  /*
   * The vitrin form posts through the same payload builder the marketplace
   * form does, and the DTO extends the marketplace DTO. These pin the three
   * facts the card page used to get wrong: a spelling the canonical list does
   * not know is a refusal that writes nothing, the timing value is the
   * marketplace select's own, and a signed-in customer's lead is proved against
   * the account's number — the one the request is stored with.
   */
  it('refuses a district the canonical list does not know, and writes nothing', async () => {
    const { card, category } = await published();

    const response = await openLead(card.id, category.slug, {
      district: 'Kadikoy',
      urgencyBucket: 'URGENT',
    });

    expect(response.status).toBe(400);
    // Class-validator's own message, in the API's words; no code accompanies it.
    expect(response.body.message).toEqual([
      'Seçilen il, ilçe ve mahalle birlikte geçerli bir adres oluşturmuyor.',
    ]);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
    expect(await ctx.prisma.notificationLog.count()).toBe(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('refuses a neighbourhood typed rather than chosen, and writes nothing', async () => {
    const { card, category } = await published();

    const response = await openLead(card.id, category.slug, {
      neighborhood: 'Caferağa',
    });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
  });

  it('accepts the canonical neighbourhood the dependent select posts', async () => {
    const { card, category } = await published();

    const response = await openLead(card.id, category.slug, {
      neighborhood: 'Caferağa Mah',
    });

    expect(response.status).toBe(201);
    const stored = await ctx.prisma.serviceRequest.findFirstOrThrow();
    expect(stored.neighborhood).toBe('Caferağa Mah');
  });

  it('refuses a body missing a required category answer, and writes nothing', async () => {
    const { card, category } = await published();
    await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: category.id,
        key: 'unit_count',
        label: 'Kaç iç ünite?',
        type: 'NUMBER',
        isRequired: true,
        sortOrder: 0,
        isActive: true,
      },
    });

    const response = await openLead(card.id, category.slug, { answers: [] });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
  });

  it('stores the timing the marketplace select posts', async () => {
    const { card, category } = await published();

    const response = await openLead(card.id, category.slug, { urgency: 'THIS_WEEK' });

    expect(response.status).toBe(201);
    const stored = await ctx.prisma.serviceRequest.findFirstOrThrow();
    expect(stored.urgency).toBe('THIS_WEEK');
  });

  it("proves a signed-in customer's lead against the account's own number", async () => {
    const { card, category } = await published();
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: '05557778899',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);
    await proveShowcaseLeadPhone(ctx.prisma, '05557778899');

    // The account path: no contact fields in the body, exactly as the shared
    // payload builder posts for a signed-in customer.
    const payload = showcaseLeadPayload(category.slug);
    delete (payload as Record<string, unknown>).customerName;
    delete (payload as Record<string, unknown>).customerPhone;
    delete (payload as Record<string, unknown>).customerEmail;

    const response = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .set('Cookie', cookie)
      .send(payload);

    expect(response.status).toBe(201);
    const stored = await ctx.prisma.serviceRequest.findFirstOrThrow();
    expect(stored.customerId).toBe(customer.id);
    // The account's own number, in the form the request service stores it —
    // the proof below is looked up under its E.164 spelling.
    expect(stored.customerPhone).toBe('05557778899');
    expect(stored.phoneVerifiedAt).not.toBeNull();

    const proof = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: '+905557778899' },
    });
    expect(proof.requestId).toBe(stored.id);
  });
});

describe('the telephone number has to be proved first', () => {
  /**
   * Mandatory here whatever `REQUIRE_PHONE_VERIFICATION` says — the one place
   * in this product where that flag is not the whole answer. The suite runs
   * with it off, so this case is exactly the one that would pass by accident if
   * the rule were the flag.
   */
  it('refuses a lead with no verified number, with the flag off', async () => {
    const { card, category } = await published();

    const response = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .send(showcaseLeadPayload(category.slug));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED');
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('stamps the request as verified and spends the proof exactly once', async () => {
    const { card, category, owner } = await published();
    const payload = showcaseLeadPayload(category.slug);
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);

    const first = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .send(payload);
    expect(first.status).toBe(201);

    const created = await ctx.prisma.serviceRequest.findFirstOrThrow({});
    expect(created.phoneVerifiedAt).not.toBeNull();

    /*
     * The proof is the consumed row, and the lead binds it to the request it
     * created. A second lead finds nothing unbound to redeem.
     *
     * Aimed at a *different* card on purpose: on the same card the ten-minute
     * dedupe window would answer first, with the lead that already exists —
     * which is correct behaviour and is asserted separately. What is proved
     * here is that one proved number buys one lead, and that has to be shown
     * where nothing else would refuse the second attempt anyway.
     */
    const secondCard = await publishAnotherCard(owner.id, category.id, 'İkinci kart');

    const second = await request(ctx.server)
      .post(`/showcase/cards/${secondCard.id}/leads`)
      .send({ ...payload, description: 'İkinci deneme' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED');
    expect(await ctx.prisma.showcaseLead.count()).toBe(1);
  });
});

describe('who can see a direct lead', () => {
  it('shows it to the card owner and to nobody else', async () => {
    const { card, category, owner, ownerCookie, rival, rivalCookie } = await published();
    await openLead(card.id, category.slug);

    const ownerInbox = await request(ctx.server)
      .get(`/providers/${owner.id}/showcase/leads`)
      .set('Cookie', ownerCookie);
    const rivalInbox = await request(ctx.server)
      .get(`/providers/${rival.id}/showcase/leads`)
      .set('Cookie', rivalCookie);

    expect(ownerInbox.body.leads).toHaveLength(1);
    expect(rivalInbox.body.leads).toHaveLength(0);
  });

  it('keeps it out of every other business’s matching-request list', async () => {
    const { card, category, rival, rivalCookie } = await published();
    await openLead(card.id, category.slug);

    const discovery = await request(ctx.server)
      .get(`/providers/${rival.id}/requests`)
      .set('Cookie', rivalCookie);

    expect(discovery.body).toHaveLength(0);
  });

  it("answers 404 when a rival guesses the lead's id", async () => {
    const { card, category, rival, rivalCookie } = await published();
    await openLead(card.id, category.slug);
    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});

    const response = await request(ctx.server)
      .get(`/providers/${rival.id}/showcase/leads/${lead.id}`)
      .set('Cookie', rivalCookie);

    expect(response.status).toBe(404);
  });

  it("keeps the customer's telephone number and address out of the inbox", async () => {
    const { card, category, owner, ownerCookie } = await published();
    await openLead(card.id, category.slug);

    const response = await request(ctx.server)
      .get(`/providers/${owner.id}/showcase/leads`)
      .set('Cookie', ownerCookie);

    // Contact opens through ContactRevealEvent and through nothing else. A
    // direct lead is not an exception to that rule.
    const [lead] = response.body.leads;
    expect(lead.request.customerPhone).toBeUndefined();
    expect(lead.request.customerEmail).toBeUndefined();
    expect(lead.request.customerName).toBeTruthy();
  });

  it('mails exactly one business and never fans out', async () => {
    const { card, category } = await published();
    await openLead(card.id, category.slug);

    const received = ctx.notifications.sent.filter(
      (message) => message.template === 'showcase-lead-received',
    );
    const fanOut = ctx.notifications.sent.filter(
      (message) => message.template === 'request-available',
    );

    expect(received).toHaveLength(1);
    // The rival matches the request perfectly. It is not invited, and that is
    // the whole promise a placement sells.
    expect(fanOut).toHaveLength(0);
  });
});

describe('answering a direct lead', () => {
  it('costs nothing, approves the request, and keeps the gate closed', async () => {
    const { card, category, owner, ownerCookie, rival, rivalCookie } = await published();
    await grantCredits(ctx.prisma, owner.id, 10);
    await openLead(card.id, category.slug);

    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});
    const balanceBefore = await currentCreditBalance(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .post(`/providers/${owner.id}/requests/${lead.requestId}/offers`)
      .set('Cookie', ownerCookie)
      .send(offerPayload());

    expect(response.status).toBe(201);

    const offer = await ctx.prisma.offer.findFirstOrThrow({});
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.SHOWCASE_PLACEMENT);
    expect(offer.creditCost).toBe(0);
    expect(offer.creditSpentTransactionId).toBeNull();
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(balanceBefore);

    const settled = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
    });
    // The offer moves the request to APPROVED in the same transaction, because
    // `acceptRequestOffer` will only ever match an APPROVED request and that
    // guard is not widened. `approvedAt` puts it into the ordinary expiry and
    // reminder machinery.
    expect(settled.status).toBe('APPROVED');
    expect(settled.approvedAt).not.toBeNull();
    // The gate is untouched: an APPROVED direct lead is still nobody else's.
    expect(settled.directShowcaseProviderId).toBe(owner.id);

    const answered = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(answered.status).toBe('ANSWERED');
    expect(answered.respondedOfferId).toBe(offer.id);

    // And the approval fans out to nobody.
    expect(
      ctx.notifications.sent.filter((message) => message.template === 'request-available'),
    ).toHaveLength(0);

    const rivalDiscovery = await request(ctx.server)
      .get(`/providers/${rival.id}/requests`)
      .set('Cookie', rivalCookie);
    expect(rivalDiscovery.body).toHaveLength(0);
  });

  it('lets the owner answer while the request is still SUBMITTED', async () => {
    const { card, category, owner, ownerCookie } = await published();
    await openLead(card.id, category.slug);
    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});

    const before = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
    });
    expect(before.status).toBe('SUBMITTED');

    const response = await request(ctx.server)
      .post(`/providers/${owner.id}/requests/${lead.requestId}/offers`)
      .set('Cookie', ownerCookie)
      .send(offerPayload());

    // The addressee can answer a lead they can already see. Everybody else
    // still needs APPROVED, which is what the next case asserts.
    expect(response.status).toBe(201);
  });

  it('refuses a rival trying to offer on the lead', async () => {
    const { card, category, rival, rivalCookie } = await published();
    await grantCredits(ctx.prisma, rival.id, 10);
    await openLead(card.id, category.slug);
    const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({});

    const response = await request(ctx.server)
      .post(`/providers/${rival.id}/requests/${lead.requestId}/offers`)
      .set('Cookie', rivalCookie)
      .send(offerPayload());

    expect(response.status).toBe(404);
  });

  it('leaves an ordinary request charging the ordinary price', async () => {
    const { category, rival, rivalCookie } = await published();
    await grantCredits(ctx.prisma, rival.id, 10);

    // The regression that matters most for the rest of the marketplace: a
    // request nobody reserved behaves exactly as it always did.
    const ordinary = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        customerName: 'Sıradan Müşteri',
        customerPhone: '05554443322',
        customerEmail: 'ordinary@example.test',
        city: 'İstanbul',
        district: 'Kadıköy',
        status: 'APPROVED',
        approvedAt: new Date(),
        qualityScore: 70,
      },
    });

    const response = await request(ctx.server)
      .post(`/providers/${rival.id}/requests/${ordinary.id}/offers`)
      .set('Cookie', rivalCookie)
      .send(offerPayload());

    expect(response.status).toBe(201);

    const offer = await ctx.prisma.offer.findFirstOrThrow({ where: { requestId: ordinary.id } });
    expect(offer.entitlementSource).toBe(OfferEntitlementSource.ONE_TIME_CREDIT);
    expect(offer.creditCost).toBe(2);
    expect(await currentCreditBalance(ctx.prisma, rival.id)).toBe(8);
  });
});

describe('the rate limits and the double-submitted form', () => {
  /**
   * Both counters compare *numbers*, not spellings.
   *
   * `ServiceRequest.customerPhone` holds what the customer typed, lightly
   * cleaned — "0555 111 22 33" stays a local number. A budget matched on that
   * column would never fire for somebody writing the same number two different
   * ways, so both counters go through the canonical form on the verification
   * each lead redeemed.
   */
  it('counts two spellings of one number as one number', async () => {
    const { card, category, owner } = await published();
    const local = '05551112233';
    const international = '+905551112233';

    // Six cards, because the dedupe window means one card cannot take six
    // leads from one person — which is the point of that window.
    const cards = [card.id];
    for (let index = 1; index < 6; index += 1) {
      const extra = await publishAnotherCard(owner.id, category.id, `Kart ${index}`);
      cards.push(extra.id);
    }

    for (let index = 0; index < 5; index += 1) {
      // Alternating spellings of the same number. Both are matched through the
      // canonical form on the verification, so the budget sees one number.
      const phone = index % 2 === 0 ? local : international;
      await proveShowcaseLeadPhone(ctx.prisma, phone);

      const response = await request(ctx.server)
        .post(`/showcase/cards/${cards[index]}/leads`)
        .send(
          showcaseLeadPayload(category.slug, {
            customerPhone: phone,
            description: `Talep ${index}`,
          }),
        );

      expect(response.status).toBe(201);
    }

    await proveShowcaseLeadPhone(ctx.prisma, local);
    const refused = await request(ctx.server)
      .post(`/showcase/cards/${cards[5]}/leads`)
      .send(showcaseLeadPayload(category.slug, { customerPhone: local }));

    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('SHOWCASE_LEAD_RATE_LIMITED');
  });

  /**
   * A double-submitted form is one lead, not two.
   *
   * Deliberately an application rule with no unique index behind it: a genuine
   * second request from the same person to the same business is perfectly
   * possible, and a constraint would refuse something legitimate. The window is
   * short enough that only a re-submitted form falls inside it.
   */
  it('answers a re-submitted form with the lead it already opened', async () => {
    const { card, category } = await published();
    const phone = '05552223344';

    await proveShowcaseLeadPhone(ctx.prisma, phone);
    const first = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .send(showcaseLeadPayload(category.slug, { customerPhone: phone }));
    expect(first.status).toBe(201);

    await proveShowcaseLeadPhone(ctx.prisma, phone);
    const second = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .send(showcaseLeadPayload(category.slug, { customerPhone: phone }));

    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(await ctx.prisma.showcaseLead.count()).toBe(1);
    expect(await ctx.prisma.serviceRequest.count()).toBe(1);
  });
});
