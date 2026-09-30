import { CreditTransactionType, OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readContactSharingConfig } from '../src/modules/contact-sharing/contact-sharing.config';
import { OFFER_ACCEPT_RECHARGE_REASON } from '../src/modules/offers/offers.service';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import { createPromoLotFixture, walletInvariant } from './campaign-fixtures';
import {
  ACCEPT_OFFER,
  backdateOfferSubmission,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * BUG-OFFER-REFUND-ACCEPT-001 — an accepted offer is always a paid one.
 *
 * The 48-hour rule pays an unviewed offer's credit back, and the customer may
 * still accept that offer afterwards. The acceptance charges `creditCost` again
 * inside its own transaction, or — when the provider cannot pay — is refused
 * with a 409 and leaves nothing behind: no match, no consent, no reveal, no
 * competing rejection, no message and no ledger row. The refund's own history
 * is never rewritten.
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

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

async function fixture(options: { paid?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const customerCookie = await loginAs(ctx.prisma, customer.id);
  const target = await addOffer(category.id, serviceRequest.id, options.paid ?? STARTING_CREDITS);
  // A competitor whose offer the acceptance would close — so a refused
  // acceptance can be shown to have closed nothing.
  const rival = await addOffer(category.id, serviceRequest.id, STARTING_CREDITS);

  return { category, customer, customerCookie, serviceRequest, ...target, rival };
}

async function addOffer(categoryId: string, requestId: string, paid: number) {
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId });
  const cookie = await loginAs(ctx.prisma, ownerUser.id);
  if (paid > 0) {
    await grantCredits(ctx.prisma, provider.id, paid);
  }

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return { provider, cookie, offerId: created.body.id as string };
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

/**
 * An administrator cannot give contact-sharing consent on the customer's
 * behalf, so an admin acceptance needs the customer's consent already on file.
 */
async function consentOnFile(requestId: string) {
  const contactSharing = readContactSharingConfig();
  await ctx.prisma.serviceRequest.update({
    where: { id: requestId },
    data: contactSharing.enabled
      ? { contactDisclosureVersion: contactSharing.disclosureVersion, contactDisclosureAcceptedAt: new Date() }
      : {},
  });
}

/** The 48-hour rule, run for real: the offer ages past its window and the worker pays it back. */
async function refundByPolicy(offerId: string) {
  await backdateOfferSubmission(ctx.prisma, offerId, 72);
  await ctx.app.get(UnviewedOfferRefundService).execute();
  const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
  expect(offer.creditRefundedTransactionId).not.toBeNull();
  return offer;
}

function customerAccept(requestId: string, offerId: string, cookie: string) {
  return request(ctx.server)
    .post(`/service-requests/${requestId}/offers/${offerId}/action`)
    .set('Cookie', cookie)
    .send(ACCEPT_OFFER);
}

function customerAction(requestId: string, offerId: string, cookie: string, action: 'SHORTLIST' | 'ACCEPT') {
  return request(ctx.server)
    .post(`/service-requests/${requestId}/offers/${offerId}/action`)
    .set('Cookie', cookie)
    .send(action === 'ACCEPT' ? ACCEPT_OFFER : { action });
}

function adminSetStatus(offerId: string, cookie: string, status: OfferStatus) {
  return request(ctx.server).patch(`/offers/${offerId}/status`).set('Cookie', cookie).send({ status });
}

function rechargeRows(offerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: {
      type: CreditTransactionType.OFFER_SPEND,
      referenceType: 'Offer',
      referenceId: offerId,
      reason: OFFER_ACCEPT_RECHARGE_REASON,
    },
  });
}

function offerLedger(offerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { referenceType: 'Offer', referenceId: offerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Moves a provider's balance down to `target` with an ADMIN_DEDUCT, the way an operator would. */
async function drainTo(providerId: string, target: number) {
  const balance = await currentCreditBalance(ctx.prisma, providerId);
  await ctx.prisma.providerCreditTransaction.create({
    data: {
      providerId,
      type: CreditTransactionType.ADMIN_DEDUCT,
      amount: target - balance,
      balanceAfter: target,
      reason: 'Test drain',
    },
  });
}

async function expectWalletConsistent(providerId: string) {
  const state = await walletInvariant(ctx.prisma, providerId);
  expect(state.sumOfAmounts).toBe(state.balance);
  expect(state.paid).toBeGreaterThanOrEqual(0);
  return state;
}

/** Everything a refused acceptance must have left exactly as it was. */
async function snapshotSideEffects(requestId: string, providerIds: string[]) {
  const [serviceRequest, offers, reveals, ledger] = await Promise.all([
    ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        status: true,
        matchedOfferId: true,
        matchedAt: true,
        contactDisclosureVersion: true,
        contactDisclosureAcceptedAt: true,
      },
    }),
    ctx.prisma.offer.findMany({
      where: { requestId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        status: true,
        acceptedAt: true,
        rejectedAt: true,
        rejectionReason: true,
        viewedAt: true,
        refundBlockedAt: true,
        creditRefundedTransactionId: true,
        creditRefundedAt: true,
      },
    }),
    ctx.prisma.contactRevealEvent.count({ where: { requestId } }),
    ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: { in: providerIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }),
  ]);
  const promo = await ctx.prisma.promoCreditLotConsumption.count();
  return { serviceRequest, offers, reveals, ledger, promo };
}

describe('accepting an offer whose credit was refunded', () => {
  it('charges creditCost again, once, and keeps the refund history intact (customer)', async () => {
    const f = await fixture();
    const refunded = await refundByPolicy(f.offerId);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS);

    const response = await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(201);
    expect(response.body.status).toBe(OfferStatus.ACCEPTED);

    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

    const ledger = await offerLedger(f.offerId);
    expect(ledger.map((row) => [row.type, row.amount])).toEqual([
      [CreditTransactionType.OFFER_SPEND, -CATEGORY_COST],
      [CreditTransactionType.OFFER_REFUND, CATEGORY_COST],
      [CreditTransactionType.OFFER_SPEND, -CATEGORY_COST],
    ]);
    const [recharge] = await rechargeRows(f.offerId);
    if (!recharge) throw new Error('no recharge row');
    expect(recharge.reason).toBe(OFFER_ACCEPT_RECHARGE_REASON);
    expect(recharge.balanceAfter).toBe(STARTING_CREDITS - CATEGORY_COST);

    // The refund stays a fact on the offer and in the ledger.
    const after = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: f.offerId } });
    expect(after.creditRefundedTransactionId).toBe(refunded.creditRefundedTransactionId);
    expect(after.creditRefundedAt).toEqual(refunded.creditRefundedAt);
    expect(after.creditRefundReason).toBe(refunded.creditRefundReason);
    expect(after.creditSpentTransactionId).toBe(refunded.creditSpentTransactionId);

    const matched = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: f.serviceRequest.id } });
    expect(matched.status).toBe(ServiceRequestStatus.MATCHED);
    expect(matched.matchedOfferId).toBe(f.offerId);

    await expectWalletConsistent(f.provider.id);
  });

  it('charges the same way when an administrator accepts on the customer’s behalf', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);
    await consentOnFile(f.serviceRequest.id);

    await adminSetStatus(f.offerId, await adminCookie(), OfferStatus.ACCEPTED).expect(200);

    expect(await rechargeRows(f.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: f.offerId } });
    expect(offer.status).toBe(OfferStatus.ACCEPTED);
    expect(offer.refundBlockedAt).not.toBeNull();
    await expectWalletConsistent(f.provider.id);
  });

  it('charges an offer an administrator refunded by hand, too', async () => {
    const f = await fixture();
    await request(ctx.server)
      .post(`/offers/${f.offerId}/refund-credit`)
      .set('Cookie', await adminCookie())
      .send({ reasonCode: 'INVALID_REQUEST' })
      .expect(201);

    await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(201);

    expect(await rechargeRows(f.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    expect(await ctx.prisma.manualOfferRefundAudit.count({ where: { offerId: f.offerId } })).toBe(1);
  });

  it('charges after a shortlist, and only at the acceptance', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);

    await customerAction(f.serviceRequest.id, f.offerId, f.customerCookie, 'SHORTLIST').expect(201);
    expect(await rechargeRows(f.offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS);

    await customerAction(f.serviceRequest.id, f.offerId, f.customerCookie, 'ACCEPT').expect(201);
    expect(await rechargeRows(f.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
  });

  it('charges nothing extra for an offer that was never refunded', async () => {
    const f = await fixture();

    await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(201);

    expect(await rechargeRows(f.offerId)).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    expect(await offerLedger(f.offerId)).toHaveLength(1);
  });
});

describe('when the provider cannot pay again', () => {
  it('refuses the customer’s acceptance with a 409 and leaves every side effect unwritten', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);
    await drainTo(f.provider.id, CATEGORY_COST - 1);
    const before = await snapshotSideEffects(f.serviceRequest.id, [f.provider.id, f.rival.provider.id]);
    ctx.notifications.clear();

    const response = await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(409);
    expect(response.body.code).toBe('OFFER_ACCEPT_INSUFFICIENT_CREDIT');
    // The customer's screen echoes this sentence; it must not talk about a wallet.
    expect(response.body.message).not.toMatch(/kredi|bakiye/i);

    const after = await snapshotSideEffects(f.serviceRequest.id, [f.provider.id, f.rival.provider.id]);
    expect(after).toEqual(before);
    expect(after.serviceRequest.status).toBe(ServiceRequestStatus.APPROVED);
    expect(after.serviceRequest.matchedOfferId).toBeNull();
    expect(after.serviceRequest.contactDisclosureAcceptedAt).toBeNull();
    expect(after.reveals).toBe(0);
    expect(after.offers.every((offer) => offer.status === OfferStatus.SUBMITTED)).toBe(true);
    // Not even the implied view: the acceptance did not happen.
    expect(after.offers.find((offer) => offer.id === f.offerId)?.viewedAt).toBeNull();
    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(CATEGORY_COST - 1);

    // Once the provider can pay, the very same acceptance goes through.
    await grantCredits(ctx.prisma, f.provider.id, 5);
    await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(201);
    expect(await rechargeRows(f.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(CATEGORY_COST - 1 + 5 - CATEGORY_COST);
    await expectWalletConsistent(f.provider.id);
  });

  it('refuses the administrator’s acceptance the same way', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);
    await consentOnFile(f.serviceRequest.id);
    await drainTo(f.provider.id, 0);
    const before = await snapshotSideEffects(f.serviceRequest.id, [f.provider.id, f.rival.provider.id]);
    ctx.notifications.clear();

    const response = await adminSetStatus(f.offerId, await adminCookie(), OfferStatus.ACCEPTED).expect(409);
    expect(response.body.code).toBe('OFFER_ACCEPT_INSUFFICIENT_CREDIT');

    expect(await snapshotSideEffects(f.serviceRequest.id, [f.provider.id, f.rival.provider.id])).toEqual(before);
    expect(ctx.notifications.sent).toHaveLength(0);
  });
});

describe('concurrency and retries', () => {
  it('charges once when the same acceptance arrives twice at the same moment', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);

    const responses = await Promise.all([
      customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie),
      customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await rechargeRows(f.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    expect(await ctx.prisma.contactRevealEvent.count({ where: { requestId: f.serviceRequest.id } })).toBe(1);
    await expectWalletConsistent(f.provider.id);
  });

  it('charges once when the customer and an administrator accept at the same moment', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);
    await consentOnFile(f.serviceRequest.id);
    const admin = await adminCookie();

    const responses = await Promise.all([
      customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie),
      adminSetStatus(f.offerId, admin, OfferStatus.ACCEPTED),
    ]);

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201 || status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    expect(await rechargeRows(f.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
  });

  it('charges only the winner when two refunded offers on one request are accepted at once', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);
    await refundByPolicy(f.rival.offerId);

    const responses = await Promise.all([
      customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie),
      customerAccept(f.serviceRequest.id, f.rival.offerId, f.customerCookie),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const charged = (await rechargeRows(f.offerId)).length + (await rechargeRows(f.rival.offerId)).length;
    expect(charged).toBe(1);
    const balances = [
      await currentCreditBalance(ctx.prisma, f.provider.id),
      await currentCreditBalance(ctx.prisma, f.rival.provider.id),
    ].sort((a, b) => a - b);
    expect(balances).toEqual([STARTING_CREDITS - CATEGORY_COST, STARTING_CREDITS]);
  });

  it('a repeated acceptance after success is a 409 and charges nothing more', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);
    await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(201);
    ctx.notifications.clear();

    const retry = await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(409);
    expect(retry.body.code).toBe('OFFER_ACTION_NOT_ALLOWED');
    await adminSetStatus(f.offerId, await adminCookie(), OfferStatus.ACCEPTED).expect(409);

    expect(await rechargeRows(f.offerId)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, f.provider.id)).toBe(STARTING_CREDITS - CATEGORY_COST);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('a retry of a refused acceptance, still unpaid, stays refused and writes nothing', async () => {
    const f = await fixture();
    await refundByPolicy(f.offerId);
    await drainTo(f.provider.id, 0);
    const before = await snapshotSideEffects(f.serviceRequest.id, [f.provider.id]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await customerAccept(f.serviceRequest.id, f.offerId, f.customerCookie).expect(409);
    }

    expect(await snapshotSideEffects(f.serviceRequest.id, [f.provider.id])).toEqual(before);
  });
});

describe('promo credit', () => {
  it('draws the charge from a valid promo lot first, exactly as a submit-time spend does', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);
    const { lot } = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 3 });
    await grantCredits(ctx.prisma, provider.id, 1);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);
    const offerId = created.body.id as string;
    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingCredits).toBe(1);

    // The refund puts the promo share back into the still-valid lot.
    await refundByPolicy(offerId);
    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingCredits).toBe(3);

    await customerAccept(serviceRequest.id, offerId, customerCookie).expect(201);

    const [recharge] = await rechargeRows(offerId);
    if (!recharge) throw new Error('no recharge row');
    const shares = await ctx.prisma.promoCreditLotConsumption.findMany({ where: { creditTransactionId: recharge.id } });
    expect(shares).toEqual([expect.objectContaining({ lotId: lot.id, consumedCredits: CATEGORY_COST })]);
    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingCredits).toBe(1);

    // The first spend's shares keep their refund settlement.
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    const firstShares = await ctx.prisma.promoCreditLotConsumption.findMany({
      where: { creditTransactionId: offer.creditSpentTransactionId! },
    });
    expect(firstShares.every((share) => share.refundTransactionId === offer.creditRefundedTransactionId)).toBe(true);

    const state = await expectWalletConsistent(provider.id);
    expect(state.balance).toBe(4 - CATEGORY_COST);
    expect(state.promoInWallet).toBe(1);
    expect(state.paid).toBe(1);
  });

  it('never lets an expired, unswept promo lot pay for the charge', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id });
    const cookie = await loginAs(ctx.prisma, ownerUser.id);
    const { lot } = await createPromoLotFixture(ctx.prisma, provider.id, { credits: CATEGORY_COST });

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);
    const offerId = created.body.id as string;
    await refundByPolicy(offerId);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(CATEGORY_COST);

    // The lot lapses and the sweep has not run yet: the credit is still in
    // the wallet's balance, but it is dead and must not buy the acceptance.
    await ctx.prisma.promoCreditLot.update({ where: { id: lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = await snapshotSideEffects(serviceRequest.id, [provider.id]);

    const response = await customerAccept(serviceRequest.id, offerId, customerCookie).expect(409);
    expect(response.body.code).toBe('OFFER_ACCEPT_INSUFFICIENT_CREDIT');
    expect(await snapshotSideEffects(serviceRequest.id, [provider.id])).toEqual(before);
  });
});
