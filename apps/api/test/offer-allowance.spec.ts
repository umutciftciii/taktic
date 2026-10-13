import { randomUUID } from 'node:crypto';
import {
  AdminPermission,
  CreditTransactionType,
  MatchRoundSource,
  OfferEntitlementSource,
  OfferPackageType,
  OfferStatus,
  ServiceCategoryKind,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addIsoDays, isoDayToStoredDate, todayIsoDay } from '../src/common/date-only';
import { ServiceIssueOutbox } from '../src/modules/notifications/service-issue-outbox.service';
import {
  readShowcaseAllowance,
  SHOWCASE_FREE_OFFER_QUOTA,
} from '../src/modules/offer-allowances/offer-allowance-ledger';
import { formatOfferAllowanceEvent } from '../src/modules/offer-allowances/offer-allowance-events';
import { ShowcaseEntitlementService } from '../src/modules/showcase/showcase-entitlement.service';
import { ShowcaseLeadSlaService } from '../src/modules/showcase/showcase-lead-sla.service';
import {
  ACCEPT_OFFER,
  createAdminWithPermissions,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createEntitlement,
  createLiveShowcasePlacement,
  createOfferPackage,
  createShowcaseEntitlement,
  createShowcasePackage,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  proveShowcaseLeadPhone,
  resetAuthThrottle,
  resetDatabase,
  showcaseLeadPayload,
  type TestContext,
} from './harness';
import { allowanceInconsistencies } from './offer-allowance-consistency';
import { roundInconsistencies } from './match-round-consistency';

/**
 * CAMPAIGN-ENTITLEMENT-001 — bounded vitrin offer allowances.
 *
 * Every placement carries {@link SHOWCASE_FREE_OFFER_QUOTA} free offers,
 * spendable only on the direct leads that came through it. The fourth answer
 * is an ordinary paid offer — and still a direct answer: the lead is ANSWERED
 * and the request leaves SUBMITTED exactly as a free answer does. Nothing is
 * given back once spent, nothing moves to another placement, and a provider is
 * never charged for an answer they were shown as free (409
 * CREDIT_COST_CHANGED, then an explicit paid retry).
 */

const CATEGORY_COST = 2;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  ctx.notifications.clear();
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, serviceIssueReportingEnabled: true },
    update: { serviceIssueReportingEnabled: true, marketplaceAutoPublishEnabled: false },
  });
});

afterEach(async () => {
  await ctx.app.get(ServiceIssueOutbox).whenIdle();
  expect(await roundInconsistencies(ctx.prisma)).toEqual([]);
  expect(await allowanceInconsistencies(ctx.prisma)).toEqual([]);
});

// ── builders ─────────────────────────────────────────────────────────────────

type Owner = { id: string; userId: string; cookie: string };

async function scenario(options: { credits?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', {
    kind: ServiceCategoryKind.LEAF,
    offerCreditCost: CATEGORY_COST,
  });
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: ownerUser.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });
  if (options.credits) {
    await grantCredits(ctx.prisma, profile.id, options.credits);
  }
  const owner: Owner = { id: profile.id, userId: ownerUser.id, cookie: await loginAs(ctx.prisma, ownerUser.id) };
  const run = await publish(owner.id, category.id);
  return { category, owner, ...run };
}

/** One approved card and a live run of it, born through `createForPurchase`. */
async function publish(providerId: string, categoryId: string, title?: string) {
  const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId, categoryId, title });
  const pkg = await createShowcasePackage(ctx.prisma);
  const { placement } = await createLiveShowcasePlacement(ctx, {
    providerId,
    cardId: card.id,
    versionId: version.id,
    packageId: pkg.id,
  });
  return { card, version, pkg, placement };
}

/** A lead from a signed-in customer (who can then reject, cancel or report). */
async function openLead(cardId: string, categorySlug: string) {
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const payload = showcaseLeadPayload(categorySlug);
  await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
  const created = await request(ctx.server)
    .post(`/showcase/cards/${cardId}/leads`)
    .set('Cookie', customerCookie)
    .send({ ...payload, useAlternateContact: true });
  expect(created.status).toBe(201);
  const lead = await ctx.prisma.showcaseLead.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  return { lead, customerCookie };
}

function offer(owner: Owner, requestId: string, body: Record<string, unknown> = offerPayload()) {
  return request(ctx.server)
    .post(`/providers/${owner.id}/requests/${requestId}/offers`)
    .set('Cookie', owner.cookie)
    .send(body);
}

function preview(owner: Owner, requestId: string) {
  return request(ctx.server)
    .get(`/providers/${owner.id}/requests/${requestId}/offer-cost`)
    .set('Cookie', owner.cookie);
}

async function grantOf(placementId: string) {
  return ctx.prisma.offerAllowanceGrant.findUniqueOrThrow({ where: { showcasePlacementId: placementId } });
}

/** Answers `count` fresh leads on the card for free, asserting each slot. */
async function spendFree(owner: Owner, cardId: string, categorySlug: string, count: number) {
  const offers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const { lead } = await openLead(cardId, categorySlug);
    const response = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 }));
    expect(response.status).toBe(201);
    expect(response.body.creditCost).toBe(0);
    offers.push(response.body.id as string);
  }
  return offers;
}

async function expireRun(placementId: string) {
  const past = new Date(Date.now() - 60_000);
  await ctx.prisma.showcasePlacement.update({
    where: { id: placementId },
    data: { status: 'EXPIRED', startAt: new Date(past.getTime() - 1000), endAt: past },
  });
  await ctx.prisma.showcasePlacementShelf.updateMany({ where: { placementId }, data: { active: false, endAt: past } });
}

// ── grants ───────────────────────────────────────────────────────────────────

describe('grants', () => {
  it('a new placement carries one grant of 3 free offers, nothing used', async () => {
    const { owner, placement } = await scenario();
    const grant = await grantOf(placement.id);
    expect(grant).toMatchObject({
      providerId: owner.id,
      source: 'SHOWCASE_PLACEMENT',
      benefit: 'FREE_OFFER',
      quotaTotal: SHOWCASE_FREE_OFFER_QUOTA,
      quotaUsed: 0,
      status: 'ACTIVE',
      voidedAt: null,
    });
    expect(SHOWCASE_FREE_OFFER_QUOTA).toBe(3);
    expect(grant.validFrom).toEqual(placement.startAt);
  });

  it('the package-first birth (createForEntitlement) grants exactly one too', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const profile = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId: category.id });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: profile.id, categoryId: category.id });
    const pkg = await createShowcasePackage(ctx.prisma);
    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    const service = ctx.app.get(ShowcaseEntitlementService);
    const now = new Date();
    const { placementId } = await ctx.prisma.$transaction(async (tx) => {
      await service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now });
      return service.consumeForCard(tx, {
        cardId: card.id,
        versionId: version.id,
        providerId: profile.id,
        categoryId: category.id,
        kind: 'SERVICE',
        now,
      });
    });

    const grants = await ctx.prisma.offerAllowanceGrant.findMany({ where: { showcasePlacementId: placementId } });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ quotaTotal: 3, quotaUsed: 0, providerId: profile.id });
    expect(await ctx.prisma.offerAllowanceGrant.count()).toBe(1);
  });

  it('a second placement row cannot get a second grant (unique scope)', async () => {
    const { owner, placement } = await scenario();
    await expect(
      ctx.prisma.offerAllowanceGrant.create({
        data: {
          providerId: owner.id,
          source: 'SHOWCASE_PLACEMENT',
          benefit: 'FREE_OFFER',
          showcasePlacementId: placement.id,
          quotaTotal: 3,
          validFrom: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

// ── consumption ──────────────────────────────────────────────────────────────

describe('consumption', () => {
  it('slots 1, 2 and 3 are free with ordinals 1..3; the 4th is the normal category price', async () => {
    const { owner, card, category, placement } = await scenario({ credits: 10 });
    const freeOffers = await spendFree(owner, card.id, category.slug, 3);

    const usages = await ctx.prisma.offerAllowanceUsage.findMany({ orderBy: { ordinal: 'asc' } });
    expect(usages.map((u) => u.ordinal)).toEqual([1, 2, 3]);
    expect(usages.map((u) => u.offerId)).toEqual(freeOffers);
    for (const usage of usages) {
      expect(usage).toMatchObject({ providerId: owner.id, categoryId: category.id, listCreditCostSnapshot: CATEGORY_COST });
    }
    for (const id of freeOffers) {
      const row = await ctx.prisma.offer.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        creditCost: 0,
        entitlementSource: OfferEntitlementSource.SHOWCASE_PLACEMENT,
        creditSpentTransactionId: null,
        unviewedRefundPolicy: false,
      });
    }
    expect(await grantOf(placement.id)).toMatchObject({ quotaTotal: 3, quotaUsed: 3 });
    // No fake ledger rows, no balance movement.
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.OFFER_SPEND } })).toBe(0);

    const { lead } = await openLead(card.id, category.slug);
    const cost = await preview(owner, lead.requestId).expect(200);
    expect(cost.body).toMatchObject({ kind: 'CREDITS', creditCost: CATEGORY_COST, allowance: { remaining: 0 } });

    const paid = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(paid.body).toMatchObject({ creditCost: CATEGORY_COST, entitlementSource: OfferEntitlementSource.ONE_TIME_CREDIT });
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10 - CATEGORY_COST);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(3);
  });

  it('the preview reports the slot and what is left before each submit', async () => {
    const { owner, card, category } = await scenario();
    const { lead } = await openLead(card.id, category.slug);
    const before = await preview(owner, lead.requestId).expect(200);
    expect(before.body).toEqual({
      kind: 'SHOWCASE_ALLOWANCE',
      creditCost: 0,
      categoryCreditCost: CATEGORY_COST,
      allowance: { quotaTotal: 3, quotaUsed: 0, remaining: 3 },
    });
    // Reading it spends nothing.
    await preview(owner, lead.requestId).expect(200);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(0);

    await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
    const { lead: next } = await openLead(card.id, category.slug);
    expect((await preview(owner, next.requestId).expect(200)).body.allowance).toEqual({
      quotaTotal: 3,
      quotaUsed: 1,
      remaining: 2,
    });
  });

  it('a paid 4th answer with no credits is a 402 once the price was confirmed; nothing is spent', async () => {
    const { owner, card, category, placement } = await scenario();
    await spendFree(owner, card.id, category.slug, 3);
    const { lead } = await openLead(card.id, category.slug);

    expect((await preview(owner, lead.requestId).expect(200)).body).toMatchObject({
      kind: 'INSUFFICIENT_CREDITS',
      creditCost: CATEGORY_COST,
    });
    await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(402);
    expect(await ctx.prisma.offer.count({ where: { requestId: lead.requestId } })).toBe(0);
    expect((await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('OPEN');
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 3 });
  });

  it('never charges an answer shown as free: expected 0 after the last slot went is a 409, then an explicit paid retry', async () => {
    const { owner, card, category } = await scenario({ credits: 10 });
    await spendFree(owner, card.id, category.slug, 2);
    const { lead: shown } = await openLead(card.id, category.slug);
    const { lead: competing } = await openLead(card.id, category.slug);

    // The form was rendered while one slot was left…
    expect((await preview(owner, shown.requestId).expect(200)).body).toMatchObject({ creditCost: 0, allowance: { remaining: 1 } });
    // …and another answer took it.
    await offer(owner, competing.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);

    const conflict = await offer(owner, shown.requestId, offerPayload({ expectedCreditCost: 0 })).expect(409);
    expect(conflict.body).toMatchObject({ code: 'CREDIT_COST_CHANGED', expectedCreditCost: 0, actualCreditCost: CATEGORY_COST });
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10);
    expect(await ctx.prisma.offer.count({ where: { requestId: shown.requestId } })).toBe(0);

    // A body with no expectation at all is not consent either.
    const omitted = await offer(owner, shown.requestId, offerPayload()).expect(409);
    expect(omitted.body).toMatchObject({ code: 'CREDIT_COST_CHANGED', expectedCreditCost: null });

    // The provider saw the new price and confirms it.
    const paid = await offer(owner, shown.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(paid.body.creditCost).toBe(CATEGORY_COST);
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10 - CATEGORY_COST);
  });

  it('with no credits, an unconfirmed paid answer is the 409 first (not the 402)', async () => {
    const { owner, card, category } = await scenario();
    await spendFree(owner, card.id, category.slug, 3);
    const { lead } = await openLead(card.id, category.slug);
    const response = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(409);
    expect(response.body.code).toBe('CREDIT_COST_CHANGED');
  });

  it('concurrency: two answers racing for the last slot — exactly one is free, the other is refused, nothing double-spent', async () => {
    const { owner, card, category, placement } = await scenario({ credits: 10 });
    await spendFree(owner, card.id, category.slug, 2);
    const { lead: a } = await openLead(card.id, category.slug);
    const { lead: b } = await openLead(card.id, category.slug);

    const [first, second] = await Promise.all([
      offer(owner, a.requestId, offerPayload({ expectedCreditCost: 0 })),
      offer(owner, b.requestId, offerPayload({ expectedCreditCost: 0 })),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.code).toBe('CREDIT_COST_CHANGED');

    expect(await grantOf(placement.id)).toMatchObject({ quotaTotal: 3, quotaUsed: 3 });
    expect((await ctx.prisma.offerAllowanceUsage.findMany()).map((u) => u.ordinal).sort()).toEqual([1, 2, 3]);
    expect(await currentCreditBalance(ctx.prisma, owner.id)).toBe(10);
  });

  it('a duplicate submit on the same lead consumes nothing more', async () => {
    const { owner, card, category, placement } = await scenario();
    const { lead } = await openLead(card.id, category.slug);
    await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
    await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(409);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 1 });
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(1);
  });
});

// ── the direct-lead identity ─────────────────────────────────────────────────

describe('a paid answer is still a direct answer', () => {
  it('marks the lead ANSWERED, approves the SUBMITTED request, keeps the gate, and carries the paid refund policy', async () => {
    const { owner, card, category } = await scenario({ credits: 10 });
    await spendFree(owner, card.id, category.slug, 3);
    const { lead } = await openLead(card.id, category.slug);
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: lead.requestId } })).status).toBe('SUBMITTED');

    const paid = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);

    const answered = await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(answered).toMatchObject({ status: 'ANSWERED', respondedOfferId: paid.body.id });
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: lead.requestId } });
    expect(row).toMatchObject({ status: 'APPROVED', directShowcaseProviderId: owner.id });
    expect(row.approvedAt).not.toBeNull();

    const stored = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: paid.body.id } });
    expect(stored.unviewedRefundPolicy).toBe(true);
    expect(stored.unviewedRefundWindowHours).toBe(48);
    expect(stored.unviewedRefundEligibleAt).not.toBeNull();
    expect(stored.creditSpentTransactionId).not.toBeNull();

    // An answered lead is not breached by the sweeper.
    await ctx.prisma.showcaseLead.update({ where: { id: lead.id }, data: { slaDueAt: new Date(Date.now() - 60_000) } });
    await ctx.app.get(ShowcaseLeadSlaService).execute();
    expect((await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('ANSWERED');
  });
});

// ── no restore ───────────────────────────────────────────────────────────────

describe('a spent slot is never given back', () => {
  it('withdraw', async () => {
    const { owner, card, category, placement } = await scenario();
    const [offerId] = await spendFree(owner, card.id, category.slug, 1);
    await request(ctx.server).post(`/providers/${owner.id}/offers/${offerId}/withdraw`).set('Cookie', owner.cookie).expect(201);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 1 });
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.OFFER_REFUND } })).toBe(0);
  });

  it('reject', async () => {
    const { owner, card, category, placement } = await scenario();
    const { lead, customerCookie } = await openLead(card.id, category.slug);
    const created = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/offers/${created.body.id}/action`)
      .set('Cookie', customerCookie)
      .send({ action: 'REJECT' })
      .expect(201);
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(OfferStatus.REJECTED);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 1 });
  });

  it('request cancel', async () => {
    const { owner, card, category, placement } = await scenario();
    const { lead, customerCookie } = await openLead(card.id, category.slug);
    const created = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
    await request(ctx.server).post(`/service-requests/${lead.requestId}/cancel`).set('Cookie', customerCookie).send({}).expect(201);
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(OfferStatus.CANCELLED);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 1 });
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.OFFER_REFUND } })).toBe(0);
  });

  it('usage rows are append-only at the database', async () => {
    const { owner, card, category } = await scenario();
    await spendFree(owner, card.id, category.slug, 1);
    const usage = await ctx.prisma.offerAllowanceUsage.findFirstOrThrow({});
    await expect(
      ctx.prisma.offerAllowanceUsage.update({ where: { id: usage.id }, data: { listCreditCostSnapshot: 99 } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.offerAllowanceUsage.delete({ where: { id: usage.id } })).rejects.toThrow(/append-only/);
  });

  it('quotaUsed is bounded by the CHECK, and a usage row must name a claimed slot of its own provider’s grant', async () => {
    const { owner, card, category, placement } = await scenario();
    const grant = await grantOf(placement.id);
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { quotaUsed: 4 } }),
    ).rejects.toThrow(/OfferAllowanceGrant_quota_used_bounded/);
    await expect(
      ctx.prisma.offerAllowanceGrant.update({ where: { id: grant.id }, data: { quotaUsed: -1 } }),
    ).rejects.toThrow(/OfferAllowanceGrant_quota_used_bounded/);

    const [offerId] = await spendFree(owner, card.id, category.slug, 1);
    const used = await ctx.prisma.offerAllowanceUsage.findFirstOrThrow({});
    const stranger = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const strangerProfile = await createDiscoverableProvider(ctx.prisma, { userId: stranger.id, categoryId: category.id });
    const base = {
      grantId: grant.id,
      requestId: used.requestId,
      matchRoundId: used.matchRoundId,
      categoryId: used.categoryId,
      listCreditCostSnapshot: 2,
    };
    // Another provider's usage on this grant.
    await expect(
      ctx.prisma.offerAllowanceUsage.create({
        data: { ...base, ordinal: 1, offerId: randomUUID(), providerId: strangerProfile.id },
      }),
    ).rejects.toThrow();
    // A slot the grant never claimed.
    await expect(
      ctx.prisma.offerAllowanceUsage.create({ data: { ...base, ordinal: 2, offerId: offerId!, providerId: owner.id } }),
    ).rejects.toThrow(/beyond the slots/);
  });
});

// ── scope: placement end, renewal, cross-placement, cross-provider ───────────

describe('scope', () => {
  it('a lead received while the run was live keeps its allowance after the run ends', async () => {
    const { owner, card, category, placement } = await scenario();
    const { lead } = await openLead(card.id, category.slug);
    await expireRun(placement.id);

    const response = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
    expect(response.body.creditCost).toBe(0);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 1 });
  });

  it('a renewal is a new placement with a fresh 3; the old grant’s unused slots do not transfer', async () => {
    const { owner, card, category, version, placement: first } = await scenario({ credits: 10 });
    await spendFree(owner, card.id, category.slug, 1);
    await expireRun(first.id);

    const pkg = await createShowcasePackage(ctx.prisma);
    const { placement: second } = await createLiveShowcasePlacement(ctx, {
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });
    expect(await grantOf(second.id)).toMatchObject({ quotaTotal: 3, quotaUsed: 0 });
    expect(await grantOf(first.id)).toMatchObject({ quotaTotal: 3, quotaUsed: 1 });

    // Three more free answers on the new run, then the price: 3, never 5.
    await spendFree(owner, card.id, category.slug, 3);
    expect(await grantOf(second.id)).toMatchObject({ quotaUsed: 3 });
    expect(await grantOf(first.id)).toMatchObject({ quotaUsed: 1 });
    const { lead } = await openLead(card.id, category.slug);
    await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(409);
  });

  it('cross-placement: a lead of an exhausted run is not paid from the provider’s other run', async () => {
    const { owner, card, category, placement } = await scenario({ credits: 10 });
    const other = await publish(owner.id, category.id, 'İkinci kart');
    await spendFree(owner, card.id, category.slug, 3);

    const { lead } = await openLead(card.id, category.slug);
    expect((await preview(owner, lead.requestId).expect(200)).body).toMatchObject({ kind: 'CREDITS', allowance: { remaining: 0 } });
    await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 3 });
    expect(await grantOf(other.placement.id)).toMatchObject({ quotaUsed: 0 });
  });

  it('cross-provider: another business cannot reach the lead, and the reader binds the grant to the lead’s own provider', async () => {
    const { owner, card, category } = await scenario();
    const rivalUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const rival = await createDiscoverableProvider(ctx.prisma, {
      userId: rivalUser.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    await grantCredits(ctx.prisma, rival.id, 10);
    const rivalOwner: Owner = { id: rival.id, userId: rivalUser.id, cookie: await loginAs(ctx.prisma, rivalUser.id) };
    const { lead } = await openLead(card.id, category.slug);

    await offer(rivalOwner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(404);
    await preview(rivalOwner, lead.requestId).expect(404);

    const facts = {
      directShowcaseProviderId: owner.id,
      showcaseLeadId: lead.id,
      roundSource: MatchRoundSource.DIRECT_SHOWCASE,
    };
    expect(await readShowcaseAllowance(ctx.prisma, { ...facts, providerId: rival.id })).toBeNull();
    expect(await readShowcaseAllowance(ctx.prisma, { ...facts, providerId: owner.id })).not.toBeNull();
    // A MARKETPLACE round never pays from an allowance, whatever the gate says.
    expect(
      await readShowcaseAllowance(ctx.prisma, { ...facts, providerId: owner.id, roundSource: MatchRoundSource.MARKETPLACE }),
    ).toBeNull();
  });

  it('a VOID grant pays for nothing', async () => {
    const { owner, card, category, placement } = await scenario({ credits: 10 });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await ctx.prisma.offerAllowanceGrant.update({
      where: { showcasePlacementId: placement.id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: 'test', voidedById: admin.id },
    });
    const { lead } = await openLead(card.id, category.slug);
    expect((await preview(owner, lead.requestId).expect(200)).body).toMatchObject({ kind: 'CREDITS', allowance: null });
  });
});

// ── RELEASE and REL-002 ─────────────────────────────────────────────────────

describe('after the gate comes down', () => {
  it('a RELEASED lead is a marketplace request: the owner pays the category price', async () => {
    const { owner, card, category, placement } = await scenario({ credits: 10 });
    const { lead, customerCookie } = await openLead(card.id, category.slug);
    await ctx.prisma.showcaseLead.update({ where: { id: lead.id }, data: { slaDueAt: new Date(Date.now() - 60_000) } });
    await ctx.app.get(ShowcaseLeadSlaService).execute();
    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/showcase-fallback`)
      .set('Cookie', customerCookie)
      .send({ decision: 'RELEASE' })
      .expect(200);
    // Released requests go through ordinary moderation.
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .patch(`/service-requests/${lead.requestId}/status`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ status: 'APPROVED' })
      .expect(200);

    expect((await preview(owner, lead.requestId).expect(200)).body).toMatchObject({ kind: 'CREDITS', allowance: null });
    const response = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(response.body.creditCost).toBe(CATEGORY_COST);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 0 });
  });

  it('REL-002: a failed R1 keeps its slot, refunds nothing, excludes the owner; R2 is MARKETPLACE and pays normally', async () => {
    const { owner, card, category, placement } = await scenario({ credits: 10 });
    const { lead, customerCookie } = await openLead(card.id, category.slug);
    const created = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
    await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/offers/${created.body.id}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);
    // The promised start has passed, so NO_SHOW is reportable.
    await ctx.prisma.offer.update({
      where: { id: created.body.id },
      data: {
        estimatedStartDate: isoDayToStoredDate(addIsoDays(todayIsoDay(), -2)),
        estimatedCompletionDate: isoDayToStoredDate(addIsoDays(todayIsoDay(), 3)),
      },
    });
    const round = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
      select: { currentRoundId: true },
    });
    const reported = await request(ctx.server)
      .post(`/service-requests/${lead.requestId}/service-issue`)
      .set('Cookie', customerCookie)
      .send({ roundId: round.currentRoundId, reason: 'PROVIDER_NO_SHOW', idempotencyKey: randomUUID() });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);

    // R1's slot stays spent; nothing was refunded.
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 1 });
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: CreditTransactionType.OFFER_REFUND } })).toBe(0);

    // R2: MARKETPLACE, the owner excluded, another business pays normally.
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .patch(`/service-requests/${lead.requestId}/status`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ status: 'APPROVED' })
      .expect(200);
    const r2 = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: lead.requestId }, include: { currentRound: true } });
    expect(r2.currentRound).toMatchObject({ roundNumber: 2, source: MatchRoundSource.MARKETPLACE });
    expect(r2.directShowcaseProviderId).toBeNull();
    await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: 0 })).expect(404);

    const otherUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const other = await createDiscoverableProvider(ctx.prisma, {
      userId: otherUser.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    await grantCredits(ctx.prisma, other.id, 10);
    const otherOwner: Owner = { id: other.id, userId: otherUser.id, cookie: await loginAs(ctx.prisma, otherUser.id) };
    expect((await preview(otherOwner, lead.requestId).expect(200)).body).toMatchObject({ kind: 'CREDITS', allowance: null });
    const r2Offer = await offer(otherOwner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(r2Offer.body.creditCost).toBe(CATEGORY_COST);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(1);
  });
});

// ── resolver ordering ────────────────────────────────────────────────────────

describe('resolver ordering', () => {
  it('a covering CATEGORY_UNLIMITED period pays first and never burns a vitrin slot', async () => {
    const { owner, card, category, placement } = await scenario();
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.CATEGORY_UNLIMITED });
    await createEntitlement(ctx.prisma, {
      providerId: owner.id,
      packageId: pkg.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      scopeCategoryIds: [category.id],
    });
    const { lead } = await openLead(card.id, category.slug);
    const cost = await preview(owner, lead.requestId).expect(200);
    expect(cost.body).toMatchObject({ kind: 'UNLIMITED', creditCost: CATEGORY_COST, allowance: { remaining: 3 } });

    const response = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(response.body.entitlementSource).toBe(OfferEntitlementSource.UNLIMITED);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 0 });
    // A paid-shape decision is still a direct answer.
    expect((await ctx.prisma.showcaseLead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('ANSWERED');
  });

  it('an unlimited period at its daily cap lets the vitrin slot answer the lead instead of refusing', async () => {
    const { owner, card, category, placement } = await scenario();
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.CATEGORY_UNLIMITED, dailyOfferLimit: 1 });
    const unlimited = await createEntitlement(ctx.prisma, {
      providerId: owner.id,
      packageId: pkg.id,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      dailyOfferLimit: 1,
      scopeCategoryIds: [category.id],
    });
    const { lead: first } = await openLead(card.id, category.slug);
    await offer(owner, first.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(await ctx.prisma.offer.count({ where: { entitlementId: unlimited.id } })).toBe(1);

    const { lead: second } = await openLead(card.id, category.slug);
    expect((await preview(owner, second.requestId).expect(200)).body).toMatchObject({ kind: 'SHOWCASE_ALLOWANCE', creditCost: 0 });
    await offer(owner, second.requestId, offerPayload({ expectedCreditCost: 0 })).expect(201);
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 1 });
  });

  it('the vitrin slot pays before a MONTHLY_QUOTA period; the quota pays once the slots are spent', async () => {
    const { owner, card, category, placement } = await scenario();
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.MONTHLY_QUOTA, quotaCredits: 20 });
    const quota = await createEntitlement(ctx.prisma, {
      providerId: owner.id,
      packageId: pkg.id,
      type: OfferPackageType.MONTHLY_QUOTA,
      quotaCredits: 20,
    });
    await spendFree(owner, card.id, category.slug, 3);
    expect((await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({ where: { id: quota.id } })).remainingQuota).toBe(20);

    const { lead } = await openLead(card.id, category.slug);
    expect((await preview(owner, lead.requestId).expect(200)).body).toMatchObject({ kind: 'MONTHLY_QUOTA', creditCost: CATEGORY_COST });
    const response = await offer(owner, lead.requestId, offerPayload({ expectedCreditCost: CATEGORY_COST })).expect(201);
    expect(response.body.entitlementSource).toBe(OfferEntitlementSource.MONTHLY_QUOTA);
    expect((await ctx.prisma.providerPackageEntitlement.findUniqueOrThrow({ where: { id: quota.id } })).remainingQuota).toBe(
      20 - CATEGORY_COST,
    );
    expect(await grantOf(placement.id)).toMatchObject({ quotaUsed: 3 });
  });

  it('a marketplace request is untouched: the category price check and charge are as before', async () => {
    const { category } = await scenario();
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const profile = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId: category.id });
    await grantCredits(ctx.prisma, profile.id, 10);
    const party: Owner = { id: profile.id, userId: user.id, cookie: await loginAs(ctx.prisma, user.id) };
    const ordinary = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        customerName: 'Sıradan',
        customerPhone: '05554443322',
        customerEmail: 'ordinary-allowance@example.test',
        city: 'İstanbul',
        district: 'Kadıköy',
        status: 'APPROVED',
        approvedAt: new Date(),
        qualityScore: 70,
      },
    });
    const stale = await offer(party, ordinary.id, offerPayload({ expectedCreditCost: 9 })).expect(409);
    expect(stale.body).toMatchObject({ code: 'CREDIT_COST_CHANGED', expectedCreditCost: 9, actualCreditCost: CATEGORY_COST });
    // No expectation on a marketplace request is still allowed, as before.
    const ok = await offer(party, ordinary.id, offerPayload()).expect(201);
    expect(ok.body.creditCost).toBe(CATEGORY_COST);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(0);
  });
});

// ── admin projections ────────────────────────────────────────────────────────

describe('admin reads', () => {
  it('placement detail carries the allowance; which offers spent it only with OFFERS_READ', async () => {
    const { owner, card, category, placement } = await scenario();
    const [offerId] = await spendFree(owner, card.id, category.slug, 1);

    const placementsOnly = await createAdminWithPermissions(ctx.prisma, [AdminPermission.SHOWCASE_PLACEMENTS_READ]);
    const narrow = await request(ctx.server)
      .get(`/admin/showcase/placements/${placement.id}`)
      .set('Cookie', await loginAs(ctx.prisma, placementsOnly.admin.id))
      .expect(200);
    expect(narrow.body.offerAllowance).toMatchObject({
      quotaTotal: 3,
      quotaUsed: 1,
      remaining: 2,
      legacyFreeOffers: 0,
      subsidyCredits: CATEGORY_COST,
      status: 'ACTIVE',
    });
    expect(narrow.body.offerAllowance).not.toHaveProperty('usages');

    const both = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.SHOWCASE_PLACEMENTS_READ,
      AdminPermission.OFFERS_READ,
    ]);
    const cookie = await loginAs(ctx.prisma, both.admin.id);
    const wide = await request(ctx.server).get(`/admin/showcase/placements/${placement.id}`).set('Cookie', cookie).expect(200);
    expect(wide.body.offerAllowance.usages).toEqual([
      expect.objectContaining({ ordinal: 1, offerId, listCreditCostSnapshot: CATEGORY_COST }),
    ]);
    expect(Object.keys(wide.body.offerAllowance.usages[0]).sort()).toEqual([
      'consumedAt',
      'listCreditCostSnapshot',
      'offerId',
      'offerNumber',
      'offerStatus',
      'ordinal',
      'requestId',
    ]);

    const detail = await request(ctx.server).get(`/offers/${offerId}`).set('Cookie', cookie).expect(200);
    expect(detail.body.offerAllowance).toMatchObject({
      ordinal: 1,
      quotaTotal: 3,
      listCreditCostSnapshot: CATEGORY_COST,
      placementId: placement.id,
    });
    expect(detail.body.entitlementSource).toBe(OfferEntitlementSource.SHOWCASE_PLACEMENT);
  });
});

// ── the operators' consistency check ─────────────────────────────────────────

describe('consistency check', () => {
  it('names a free allowance offer that somehow got a ledger row, and a live run without a grant', async () => {
    const { owner, card, category, placement } = await scenario();
    const [offerId] = await spendFree(owner, card.id, category.slug, 1);
    const stray = await ctx.prisma.providerCreditTransaction.create({
      data: {
        providerId: owner.id,
        type: CreditTransactionType.OFFER_SPEND,
        amount: 0,
        balanceAfter: 0,
        referenceType: 'Offer',
        referenceId: offerId,
      },
    });
    const grant = await grantOf(placement.id);
    expect(await allowanceInconsistencies(ctx.prisma)).toEqual([{ check: 'USAGE_OFFER_HAS_LEDGER', subject: expect.any(String) }]);

    await ctx.prisma.providerCreditTransaction.delete({ where: { id: stray.id } });
    expect(await allowanceInconsistencies(ctx.prisma)).toEqual([]);
    expect(grant.quotaUsed).toBe(1);
  });
});

// ── observability ────────────────────────────────────────────────────────────

describe('events', () => {
  it('are one greppable line of ids and numbers', () => {
    expect(
      formatOfferAllowanceEvent('offer_allowance_consumed', { grantId: 'g1', offerId: 'o1', ordinal: 2, quotaTotal: 3 }),
    ).toBe('offer_allowance_event event=offer_allowance_consumed grantId=g1 offerId=o1 ordinal=2 quotaTotal=3');
  });
});
