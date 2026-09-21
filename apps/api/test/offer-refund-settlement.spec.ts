import { CampaignRevokeReason, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PromoCreditLotExpiryService } from '../src/modules/credits/promo-credit-lot-expiry.service';
import { revokePromoCreditLot } from '../src/modules/credits/promo-credit-ledger';
import {
  readOfferRefundSettlements,
  summarizeOfferRefundSettlement,
  type OfferRefundSettlement,
} from '../src/modules/credits/offer-refund-settlement';
import { createPromoLotFixture, walletInvariant } from './campaign-fixtures';
import {
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
 * CMP-004 S4 — the one refund figure every surface reads.
 *
 * A refund writes its OFFER_REFUND row exactly as before (S2B1) and, when a
 * promo lot paid part of the offer, either puts that share back into the lot
 * or forfeits it through a CAMPAIGN_EXPIRE / CAMPAIGN_REVOKE row. What the
 * provider must be told is the *net* of all of that, and it must be the same
 * number in the API response, in the e-mail and on the web — so it is
 * produced once, from the rows the refund wrote, and re-read later by exact
 * reference (the consumption rows that name this refund), never by a search
 * of the ledger.
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

async function providerFixture(options: { categoryCost?: number; paid?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: options.categoryCost ?? 1 });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
  const cookie = await loginAs(ctx.prisma, owner.id);
  if (options.paid) {
    await grantCredits(ctx.prisma, provider.id, options.paid);
  }
  return { category, owner, provider, cookie };
}

async function submitOffer(fixture: { category: { id: string }; provider: { id: string }; cookie: string }) {
  const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id });
  const response = await request(ctx.server)
    .post(`/providers/${fixture.provider.id}/requests/${serviceRequest.id}/offers`)
    .set('Cookie', fixture.cookie)
    .send(offerPayload())
    .expect(201);
  return { serviceRequest, offerId: response.body.id as string };
}

async function manualRefund(offerId: string, expected = 201) {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const cookie = await loginAs(ctx.prisma, admin.id);
  return request(ctx.server)
    .post(`/offers/${offerId}/refund-credit`)
    .set('Cookie', cookie)
    .send({ reasonCode: 'INVALID_REQUEST' })
    .expect(expected);
}

async function refundRowOf(offerId: string) {
  const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
  return offer.creditRefundedTransactionId!;
}

async function readSettlement(refundTransactionId: string): Promise<OfferRefundSettlement> {
  const map = await readOfferRefundSettlements(ctx.prisma, [refundTransactionId]);
  return map.get(refundTransactionId)!;
}

async function expectInvariant(providerId: string) {
  const state = await walletInvariant(ctx.prisma, providerId);
  expect(state.sumOfAmounts).toBe(state.balance);
  expect(state.paid).toBeGreaterThanOrEqual(0);
  return state;
}

describe('summarizeOfferRefundSettlement (pure)', () => {
  const refund = { id: 'refund-1', amount: 5, balanceAfter: 12 };

  it('a refund with no promo share is the gross figure, net of nothing', () => {
    expect(summarizeOfferRefundSettlement(refund, [])).toEqual({
      refundTransactionId: 'refund-1',
      grossCredits: 5,
      promoRestoredCredits: 0,
      promoForfeitedCredits: { expired: 0, revoked: 0, total: 0 },
      netCredits: 5,
      balanceBefore: 7,
      balanceAfter: 12,
    });
  });

  it('adds forfeits by their ledger type and reports the wallet after the last forfeit row', () => {
    const settlement = summarizeOfferRefundSettlement(refund, [
      { status: 'REFUNDED', refundedCredits: 1, forfeitedCredits: 0, forfeitTransaction: null },
      {
        status: 'FORFEITED',
        refundedCredits: 0,
        forfeitedCredits: 3,
        forfeitTransaction: { id: 'f1', type: 'CAMPAIGN_EXPIRE', balanceAfter: 9, createdAt: new Date('2026-09-22T10:00:00Z') },
      },
      {
        status: 'FORFEITED',
        refundedCredits: 0,
        forfeitedCredits: 1,
        forfeitTransaction: { id: 'f2', type: 'CAMPAIGN_REVOKE', balanceAfter: 8, createdAt: new Date('2026-09-22T10:00:00Z') },
      },
    ]);
    expect(settlement).toEqual({
      refundTransactionId: 'refund-1',
      grossCredits: 5,
      promoRestoredCredits: 1,
      promoForfeitedCredits: { expired: 3, revoked: 1, total: 4 },
      netCredits: 1,
      balanceBefore: 7,
      balanceAfter: 8,
    });
  });
});

describe('refund settlement through the real refund path', () => {
  it('without a promo lot: gross equals net, and the response, the reader and the ledger agree', async () => {
    const fixture = await providerFixture({ categoryCost: 3, paid: 10 });
    const { offerId } = await submitOffer(fixture);

    const response = await manualRefund(offerId);
    expect(response.body.balance).toBe(10);
    const expected: OfferRefundSettlement = {
      refundTransactionId: await refundRowOf(offerId),
      grossCredits: 3,
      promoRestoredCredits: 0,
      promoForfeitedCredits: { expired: 0, revoked: 0, total: 0 },
      netCredits: 3,
      balanceBefore: 7,
      balanceAfter: 10,
    };
    expect(response.body.settlement).toEqual(expected);
    expect(await readSettlement(expected.refundTransactionId)).toEqual(expected);
    await expectInvariant(fixture.provider.id);
  });

  it('a share that goes back into a valid lot is restored, not forfeited: net stays gross', async () => {
    const fixture = await providerFixture({ categoryCost: 5, paid: 2 });
    await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 3 });
    const { offerId } = await submitOffer(fixture);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(0);

    const response = await manualRefund(offerId);
    const settlement = response.body.settlement as OfferRefundSettlement;
    expect(settlement).toMatchObject({
      grossCredits: 5,
      promoRestoredCredits: 3,
      promoForfeitedCredits: { expired: 0, revoked: 0, total: 0 },
      netCredits: 5,
      balanceBefore: 0,
      balanceAfter: 5,
    });
    expect(await readSettlement(settlement.refundTransactionId)).toEqual(settlement);
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 5, paid: 2, promoInWallet: 3 });
  });

  it('a share whose lot expired after the spend is forfeited: net is the paid share only', async () => {
    const fixture = await providerFixture({ categoryCost: 5, paid: 2 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 3, expiresAt: new Date(Date.now() + 5_000) });
    const { offerId } = await submitOffer(fixture);

    await ctx.prisma.promoCreditLot.update({ where: { id: granted.lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await ctx.app.get(PromoCreditLotExpiryService).expireDueLots(new Date());

    const response = await manualRefund(offerId);
    const settlement = response.body.settlement as OfferRefundSettlement;
    expect(settlement).toMatchObject({
      grossCredits: 5,
      promoRestoredCredits: 0,
      promoForfeitedCredits: { expired: 3, revoked: 0, total: 3 },
      netCredits: 2,
      balanceBefore: 0,
      balanceAfter: 2,
    });
    expect(response.body.balance).toBe(2);
    expect(await readSettlement(settlement.refundTransactionId)).toEqual(settlement);
    // The dead lot did not come back to life, and no paid credit was invented.
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 2, paid: 2, promoInWallet: 0 });
  });

  it('a share whose lot was revoked is forfeited under the revoke heading', async () => {
    const fixture = await providerFixture({ categoryCost: 5, paid: 2 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 3 });
    const { offerId } = await submitOffer(fixture);

    await ctx.prisma.$transaction(
      (tx) => revokePromoCreditLot(tx, { lotId: granted.lot.id, reason: CampaignRevokeReason.PAYMENT_REVERSED, revokedById: null, now: new Date() }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const response = await manualRefund(offerId);
    const settlement = response.body.settlement as OfferRefundSettlement;
    expect(settlement).toMatchObject({
      grossCredits: 5,
      promoForfeitedCredits: { expired: 0, revoked: 3, total: 3 },
      netCredits: 2,
      balanceAfter: 2,
    });
    expect(await readSettlement(settlement.refundTransactionId)).toEqual(settlement);
    await expectInvariant(fixture.provider.id);
  });

  it('a second refund is refused and the settlement it would have produced does not exist', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 4 });
    const { offerId } = await submitOffer(fixture);
    const first = (await manualRefund(offerId)).body.settlement as OfferRefundSettlement;

    await manualRefund(offerId, 409);

    const refunds = await ctx.prisma.providerCreditTransaction.count({ where: { providerId: fixture.provider.id, type: 'OFFER_REFUND' } });
    expect(refunds).toBe(1);
    expect(await readSettlement(first.refundTransactionId)).toEqual(first);
    expect(ctx.notifications.ofTemplate('credit-refunded')).toHaveLength(1);
  });

  it('asked about a row that is not a refund, the reader answers nothing rather than guessing', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 4 });
    const { offerId } = await submitOffer(fixture);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    const map = await readOfferRefundSettlements(ctx.prisma, [offer.creditSpentTransactionId!, 'does-not-exist']);
    expect(map.size).toBe(0);
  });
});
