import { CreditTransactionType, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expirePromoCreditLot,
  grantPromoCreditLot,
  revokePromoCreditLot,
} from '../src/modules/credits/promo-credit-ledger';
import { PromoCreditLotExpiryService } from '../src/modules/credits/promo-credit-lot-expiry.service';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import { createPromoLotFixture, walletInvariant } from './campaign-fixtures';
import {
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
 * CMP-002 S2B1: promo credit accounting, driven through the real offer and
 * refund transactions wherever one exists (HTTP offer submission, the
 * unviewed-offer worker, the manual admin refund, the request-removal
 * cascade) and through the primitives where no production caller exists
 * yet (grant, expire, revoke, the expiry sweep).
 *
 * Every scenario ends by checking the wallet invariant of the design note
 * §5: the ledger sums to the newest balance, and that balance equals the
 * paid share plus every lot remainder still inside the wallet.
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

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY);

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

async function submitOffer(fixture: { category: { id: string }; provider: { id: string }; cookie: string }, expected = 201) {
  const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id });
  const response = await request(ctx.server)
    .post(`/providers/${fixture.provider.id}/requests/${serviceRequest.id}/offers`)
    .set('Cookie', fixture.cookie)
    .send(offerPayload())
    .expect(expected);
  return { serviceRequest, offerId: response.body.id as string | undefined, response };
}

function ledger(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { type: true, amount: true, balanceAfter: true, referenceType: true, referenceId: true, reason: true },
  });
}

function lot(id: string) {
  return ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id } });
}

function consumptionsOf(spendTransactionId: string | null | undefined) {
  return ctx.prisma.promoCreditLotConsumption.findMany({
    where: { creditTransactionId: spendTransactionId ?? '' },
    orderBy: { id: 'asc' },
  });
}

async function spendRowOf(offerId: string) {
  const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
  return offer.creditSpentTransactionId;
}

async function expectInvariant(providerId: string) {
  const state = await walletInvariant(ctx.prisma, providerId);
  expect(state.sumOfAmounts).toBe(state.balance);
  expect(state.paid).toBeGreaterThanOrEqual(0);
  return state;
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

function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return ctx.prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// ───────────────────────────── primitives ─────────────────────────────

describe('grant primitive', () => {
  it('writes one CAMPAIGN_GRANT row, one lot and the redemption link, and refuses a second grant', async () => {
    const { provider } = await providerFixture({ paid: 2 });
    const granted = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 5 });

    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(7);
    expect(await ledger(provider.id)).toEqual([
      expect.objectContaining({ type: 'ADMIN_GRANT', amount: 2, balanceAfter: 2 }),
      expect.objectContaining({ type: 'CAMPAIGN_GRANT', amount: 5, balanceAfter: 7, referenceType: 'CampaignRedemption', referenceId: granted.redemption.id, reason: 'CAMPAIGN_GRANT' }),
    ]);
    expect(granted.lot).toMatchObject({ grantedCredits: 5, remainingCredits: 5, status: 'ACTIVE' });
    const redemption = await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: granted.redemption.id } });
    expect(redemption.grantTransactionId).toBe(granted.grantTransactionId);

    await expect(
      serializable((tx) => grantPromoCreditLot(tx, { providerId: provider.id, redemptionId: granted.redemption.id, credits: 5, expiresAt: inDays(30), now: new Date() })),
    ).rejects.toMatchObject({ code: 'P2034' });
    expect(await ctx.prisma.promoCreditLot.count()).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'CAMPAIGN_GRANT' } })).toBe(1);
    const state = await expectInvariant(provider.id);
    expect(state).toMatchObject({ balance: 7, paid: 2, promoInWallet: 5 });
  });
});

describe('expiry primitive and sweep', () => {
  it('takes the remainder out once, marks the lot and redemption EXPIRED, and does nothing the second time', async () => {
    const { provider } = await providerFixture({ paid: 3 });
    const due = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 4, expiresAt: new Date(Date.now() - 1000) });
    const live = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 6, expiresAt: inDays(10) });

    const first = await serializable((tx) => expirePromoCreditLot(tx, { lotId: due.lot.id, now: new Date() }));
    expect(first).toMatchObject({ expired: true, credits: 4 });
    expect(await lot(due.lot.id)).toMatchObject({ status: 'EXPIRED', remainingCredits: 0, expiryTransactionId: first.transactionId });
    expect((await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: due.redemption.id } })).status).toBe('EXPIRED');
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(3 + 6);

    const second = await serializable((tx) => expirePromoCreditLot(tx, { lotId: due.lot.id, now: new Date() }));
    expect(second).toEqual({ expired: false, transactionId: null, credits: 0 });
    const notDue = await serializable((tx) => expirePromoCreditLot(tx, { lotId: live.lot.id, now: new Date() }));
    expect(notDue.expired).toBe(false);

    expect((await ledger(provider.id)).filter((row) => row.type === 'CAMPAIGN_EXPIRE')).toEqual([
      expect.objectContaining({ amount: -4, balanceAfter: 9, referenceType: 'PromoCreditLot', referenceId: due.lot.id, reason: 'PROMO_LOT_EXPIRED' }),
    ]);
    const state = await expectInvariant(provider.id);
    expect(state).toMatchObject({ balance: 9, paid: 3, promoInWallet: 6 });
  });

  it('expires an exhausted lot without a ledger row', async () => {
    const { provider } = await providerFixture();
    const granted = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 2, expiresAt: new Date(Date.now() - 1000) });
    await ctx.prisma.promoCreditLot.update({ where: { id: granted.lot.id }, data: { remainingCredits: 0, status: 'EXHAUSTED' } });
    // Keep the wallet honest for the invariant: the two credits were "spent".
    await ctx.prisma.providerCreditTransaction.create({
      data: { providerId: provider.id, type: 'OFFER_SPEND', amount: -2, balanceAfter: 0, referenceType: 'Offer', referenceId: 'x' },
    });

    const result = await serializable((tx) => expirePromoCreditLot(tx, { lotId: granted.lot.id, now: new Date() }));
    expect(result).toEqual({ expired: true, transactionId: null, credits: 0 });
    expect(await lot(granted.lot.id)).toMatchObject({ status: 'EXPIRED', remainingCredits: 0, expiryTransactionId: null });
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'CAMPAIGN_EXPIRE' } })).toBe(0);
    await expectInvariant(provider.id);
  });

  it('the sweep expires every due lot exactly once across providers and a second sweep writes nothing', async () => {
    const a = await providerFixture({ paid: 1 });
    const b = await providerFixture();
    const dueA = await createPromoLotFixture(ctx.prisma, a.provider.id, { credits: 3, expiresAt: new Date(Date.now() - DAY) });
    const dueB = await createPromoLotFixture(ctx.prisma, b.provider.id, { credits: 7, expiresAt: new Date(Date.now() - 60_000) });
    const liveB = await createPromoLotFixture(ctx.prisma, b.provider.id, { credits: 2, expiresAt: inDays(1) });

    const sweep = ctx.app.get(PromoCreditLotExpiryService);
    const first = await sweep.expireDueLots(new Date());
    expect(first).toMatchObject({ candidates: 2, expired: 2, creditsExpired: 10 });
    expect(await lot(dueA.lot.id)).toMatchObject({ status: 'EXPIRED', remainingCredits: 0 });
    expect(await lot(dueB.lot.id)).toMatchObject({ status: 'EXPIRED', remainingCredits: 0 });
    expect(await lot(liveB.lot.id)).toMatchObject({ status: 'ACTIVE', remainingCredits: 2 });
    expect(await currentCreditBalance(ctx.prisma, a.provider.id)).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, b.provider.id)).toBe(2);

    const rowsBefore = await ctx.prisma.providerCreditTransaction.count();
    const second = await sweep.expireDueLots(new Date());
    expect(second).toMatchObject({ candidates: 0, expired: 0, creditsExpired: 0 });
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(rowsBefore);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'CAMPAIGN_EXPIRE' } })).toBe(2);
    await expectInvariant(a.provider.id);
    await expectInvariant(b.provider.id);
  });
});

describe('revoke primitive', () => {
  it('forfeits the remainder once, records what was spent, and is a no-op afterwards', async () => {
    const { provider } = await providerFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const granted = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 10 });
    await ctx.prisma.promoCreditLot.update({ where: { id: granted.lot.id }, data: { remainingCredits: 6 } });
    await ctx.prisma.providerCreditTransaction.create({
      data: { providerId: provider.id, type: 'OFFER_SPEND', amount: -4, balanceAfter: 6, referenceType: 'Offer', referenceId: 'x' },
    });

    const result = await serializable((tx) => revokePromoCreditLot(tx, { lotId: granted.lot.id, reason: 'ADMIN_REVOKED', revokedById: admin.id, now: new Date() }));
    expect(result).toMatchObject({ revoked: true, credits: 6 });
    expect(await lot(granted.lot.id)).toMatchObject({ status: 'REVOKED', remainingCredits: 0, revokeTransactionId: result.transactionId });
    expect(await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: granted.redemption.id } })).toMatchObject({
      status: 'REVOKED',
      revokeReason: 'ADMIN_REVOKED',
      spentAtRevoke: 4,
      revokedById: admin.id,
    });
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    expect((await ledger(provider.id)).at(-1)).toMatchObject({ type: 'CAMPAIGN_REVOKE', amount: -6, reason: 'PROMO_LOT_REVOKED:ADMIN_REVOKED', referenceId: granted.lot.id });

    const again = await serializable((tx) => revokePromoCreditLot(tx, { lotId: granted.lot.id, reason: 'ADMIN_REVOKED', revokedById: admin.id, now: new Date() }));
    expect(again).toEqual({ revoked: false, transactionId: null, credits: 0 });
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'CAMPAIGN_REVOKE' } })).toBe(1);
    await expectInvariant(provider.id);
  });
});

// ───────────────────────────── spend ─────────────────────────────

describe('offer spend', () => {
  it('without a promo lot: the paid path is byte-for-byte what it was', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 5 });
    const { offerId } = await submitOffer(fixture);

    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(3);
    expect(await ledger(fixture.provider.id)).toEqual([
      expect.objectContaining({ type: 'ADMIN_GRANT', amount: 5, balanceAfter: 5 }),
      expect.objectContaining({ type: 'OFFER_SPEND', amount: -2, balanceAfter: 3, referenceType: 'Offer', referenceId: offerId }),
    ]);
    expect(await ctx.prisma.promoCreditLotConsumption.count()).toBe(0);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(0);

    // The 402 and its zero-write contract are unchanged too.
    const poor = await providerFixture({ categoryCost: 2, paid: 1 });
    await submitOffer(poor, 402);
    expect(await ctx.prisma.offer.count({ where: { providerId: poor.provider.id } })).toBe(0);
    expect(await ledger(poor.provider.id)).toHaveLength(1);
  });

  it('takes the earliest-expiring lot first, then the next, then the paid balance', async () => {
    const fixture = await providerFixture({ categoryCost: 4, paid: 3 });
    const later = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2, expiresAt: inDays(20) });
    const sooner = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 1, expiresAt: inDays(5) });
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(6);

    const { offerId } = await submitOffer(fixture);
    const spendId = await spendRowOf(offerId!);

    // One OFFER_SPEND for the whole cost, exactly as before.
    const rows = await ledger(fixture.provider.id);
    expect(rows.filter((row) => row.type === 'OFFER_SPEND')).toEqual([
      expect.objectContaining({ amount: -4, balanceAfter: 2, referenceId: offerId }),
    ]);
    // 1 from the lot expiring in 5 days, 2 from the one expiring in 20, 1 paid.
    expect(await consumptionsOf(spendId)).toEqual([
      expect.objectContaining({ lotId: sooner.lot.id, consumedCredits: 1, status: 'CONSUMED' }),
      expect.objectContaining({ lotId: later.lot.id, consumedCredits: 2, status: 'CONSUMED' }),
    ]);
    expect(await lot(sooner.lot.id)).toMatchObject({ remainingCredits: 0, status: 'EXHAUSTED' });
    expect(await lot(later.lot.id)).toMatchObject({ remainingCredits: 0, status: 'EXHAUSTED' });
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 2, paid: 2, promoInWallet: 0 });
  });

  it('leaves the paid balance untouched while promo covers the cost, and keeps the rest of the lot ACTIVE', async () => {
    const fixture = await providerFixture({ categoryCost: 3, paid: 4 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 5 });

    const { offerId } = await submitOffer(fixture);

    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(6);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 2, status: 'ACTIVE' });
    expect(await consumptionsOf(await spendRowOf(offerId!))).toEqual([
      expect.objectContaining({ lotId: granted.lot.id, consumedCredits: 3 }),
    ]);
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 6, paid: 4, promoInWallet: 2 });
  });

  it('never spends a lot whose expiry has passed but which the sweep has not reached', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 1 });
    const dead = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 5, expiresAt: new Date(Date.now() - 1000) });
    // The wallet still says 6; only 1 of it can pay.
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(6);

    await submitOffer(fixture, 402);
    expect(await ctx.prisma.promoCreditLotConsumption.count()).toBe(0);
    expect(await lot(dead.lot.id)).toMatchObject({ remainingCredits: 5, status: 'ACTIVE' });

    // With enough paid credit the offer goes through and the dead lot is still not touched.
    await grantCredits(ctx.prisma, fixture.provider.id, 1);
    const { offerId } = await submitOffer(fixture);
    expect(await consumptionsOf(await spendRowOf(offerId!))).toEqual([]);
    expect(await lot(dead.lot.id)).toMatchObject({ remainingCredits: 5, status: 'ACTIVE' });
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 5, paid: 0, promoInWallet: 5 });
  });

  it('two concurrent offers cannot both take the last promo credit', async () => {
    const fixture = await providerFixture({ categoryCost: 1, paid: 1 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 1 });
    const first = await createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id });
    const second = await createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id });

    const [a, b] = await Promise.all([
      request(ctx.server).post(`/providers/${fixture.provider.id}/requests/${first.id}/offers`).set('Cookie', fixture.cookie).send(offerPayload()),
      request(ctx.server).post(`/providers/${fixture.provider.id}/requests/${second.id}/offers`).set('Cookie', fixture.cookie).send(offerPayload()),
    ]);
    expect([a.status, b.status].filter((status) => status === 201)).toHaveLength(2);

    // One credit from the lot, one paid; the lot was consumed exactly once.
    expect(await ctx.prisma.promoCreditLotConsumption.count()).toBe(1);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 0, status: 'EXHAUSTED' });
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(0);
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 0, paid: 0, promoInWallet: 0 });
  });
});

// ───────────────────────────── refund ─────────────────────────────

describe('offer refund', () => {
  it('without a promo lot: the worker refund is byte-for-byte what it was', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 5 });
    const { offerId } = await submitOffer(fixture);
    await backdateOfferSubmission(ctx.prisma, offerId!, 72);

    const result = await ctx.app.get(UnviewedOfferRefundService).execute();
    expect(result.results.filter((row) => row.status === 'REFUNDED')).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(5);
    expect((await ledger(fixture.provider.id)).map((row) => row.type)).toEqual(['ADMIN_GRANT', 'OFFER_SPEND', 'OFFER_REFUND']);
    expect(await ctx.prisma.promoCreditLotConsumption.count()).toBe(0);
  });

  it('puts a promo share back into a lot that is still valid (worker path), reviving an exhausted lot', async () => {
    const fixture = await providerFixture({ categoryCost: 3, paid: 2 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2 });
    const { offerId } = await submitOffer(fixture);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 0, status: 'EXHAUSTED' });
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(1);
    await backdateOfferSubmission(ctx.prisma, offerId!, 72);

    await ctx.app.get(UnviewedOfferRefundService).execute();

    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(4);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 2, status: 'ACTIVE' });
    const spendId = await spendRowOf(offerId!);
    const [share] = await consumptionsOf(spendId);
    expect(share).toMatchObject({ status: 'REFUNDED', refundedCredits: 2, forfeitedCredits: 0, forfeitTransactionId: null });
    expect(share!.refundTransactionId).not.toBeNull();
    expect(share!.settledAt).not.toBeNull();
    // Exactly the refund row moved the wallet; nothing else was written.
    expect((await ledger(fixture.provider.id)).map((row) => [row.type, row.amount])).toEqual([
      ['ADMIN_GRANT', 2], ['CAMPAIGN_GRANT', 2], ['OFFER_SPEND', -3], ['OFFER_REFUND', 3],
    ]);
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 4, paid: 2, promoInWallet: 2 });
  });

  it('forfeits the promo share when the lot expired after the spend (manual admin refund), keeping only the paid share', async () => {
    const fixture = await providerFixture({ categoryCost: 3, paid: 2 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 4, expiresAt: new Date(Date.now() + 5_000) });
    const { offerId } = await submitOffer(fixture);
    // 3 from the lot; 1 remains; nothing paid.
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(3);

    // The lot dies: sweep it past its expiry.
    await ctx.prisma.promoCreditLot.update({ where: { id: granted.lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const sweep = await ctx.app.get(PromoCreditLotExpiryService).expireDueLots(new Date());
    expect(sweep).toMatchObject({ expired: 1, creditsExpired: 1 });
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(2);

    const response = await manualRefund(offerId!);
    // The response reports the wallet after the forfeit, not after the refund row alone.
    expect(response.body.balance).toBe(2);
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(2);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 0, status: 'EXPIRED' });

    const spendId = await spendRowOf(offerId!);
    const [share] = await consumptionsOf(spendId);
    expect(share).toMatchObject({ status: 'FORFEITED', forfeitedCredits: 3, refundedCredits: 0 });
    const rows = await ledger(fixture.provider.id);
    expect(rows.map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
      ['ADMIN_GRANT', 2, 2],
      ['CAMPAIGN_GRANT', 4, 6],
      ['OFFER_SPEND', -3, 3],
      ['CAMPAIGN_EXPIRE', -1, 2],
      ['OFFER_REFUND', 3, 5],
      ['CAMPAIGN_EXPIRE', -3, 2],
    ]);
    expect(rows.at(-1)).toMatchObject({ referenceType: 'PromoCreditLotConsumption', referenceId: share!.id, reason: 'PROMO_FORFEIT_ON_REFUND:EXPIRED' });
    const audit = await ctx.prisma.manualOfferRefundAudit.findUniqueOrThrow({ where: { offerId: offerId! } });
    expect(audit.creditAmount).toBe(3);
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 2, paid: 2, promoInWallet: 0 });
  });

  it('forfeits the promo share when the lot is past its expiry but not yet swept', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 1 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 3, expiresAt: new Date(Date.now() + 5_000) });
    const { offerId } = await submitOffer(fixture);
    await ctx.prisma.promoCreditLot.update({ where: { id: granted.lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await manualRefund(offerId!);

    // The unswept remainder (1) is still in the wallet; the refunded share (2) is not.
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(2);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 1, status: 'ACTIVE' });
    expect((await consumptionsOf(await spendRowOf(offerId!)))[0]).toMatchObject({ status: 'FORFEITED', forfeitedCredits: 2 });
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 2, paid: 1, promoInWallet: 1 });

    // The sweep then takes the remainder, and the lot's own ledger link is separate from the forfeit's.
    await ctx.app.get(PromoCreditLotExpiryService).expireDueLots(new Date());
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'CAMPAIGN_EXPIRE' } })).toBe(2);
    await expectInvariant(fixture.provider.id);
  });

  it('forfeits the promo share with a CAMPAIGN_REVOKE row when the lot was revoked (request-removal path)', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 1 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 3 });
    const { serviceRequest, offerId } = await submitOffer(fixture);
    await serializable((tx) => revokePromoCreditLot(tx, { lotId: granted.lot.id, reason: 'PAYMENT_REVERSED', revokedById: null, now: new Date() }));
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(1);

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    await request(ctx.server)
      .patch(`/service-requests/${serviceRequest.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'REJECTED', rejectionReason: 'Sahte talep' })
      .expect(200);

    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(1);
    const [share] = await consumptionsOf(await spendRowOf(offerId!));
    expect(share).toMatchObject({ status: 'FORFEITED', forfeitedCredits: 2 });
    expect((await ledger(fixture.provider.id)).at(-1)).toMatchObject({ type: 'CAMPAIGN_REVOKE', amount: -2, reason: 'PROMO_FORFEIT_ON_REFUND:REVOKED', referenceId: share!.id });
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 1, paid: 1, promoInWallet: 0 });
  });

  it('settles a mixed spend lot by lot: one share revived, one forfeited', async () => {
    const fixture = await providerFixture({ categoryCost: 5, paid: 2 });
    const sooner = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2, expiresAt: new Date(Date.now() + 5_000) });
    const later = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2, expiresAt: inDays(20) });
    const { offerId } = await submitOffer(fixture);
    // 2 + 2 promo, 1 paid.
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(1);
    await ctx.prisma.promoCreditLot.update({ where: { id: sooner.lot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await ctx.app.get(PromoCreditLotExpiryService).expireDueLots(new Date());

    await manualRefund(offerId!);

    // Paid 1 back, later lot's 2 back, sooner lot's 2 forfeited.
    expect(await currentCreditBalance(ctx.prisma, fixture.provider.id)).toBe(4);
    expect(await lot(sooner.lot.id)).toMatchObject({ status: 'EXPIRED', remainingCredits: 0 });
    expect(await lot(later.lot.id)).toMatchObject({ status: 'ACTIVE', remainingCredits: 2 });
    expect(await consumptionsOf(await spendRowOf(offerId!))).toEqual([
      expect.objectContaining({ lotId: sooner.lot.id, status: 'FORFEITED', forfeitedCredits: 2 }),
      expect.objectContaining({ lotId: later.lot.id, status: 'REFUNDED', refundedCredits: 2 }),
    ]);
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 4, paid: 2, promoInWallet: 2 });
  });

  it('a second refund of the same offer is refused before any share can move again', async () => {
    const fixture = await providerFixture({ categoryCost: 2, paid: 1 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2 });
    const { offerId } = await submitOffer(fixture);
    await manualRefund(offerId!);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 2 });
    const rowsAfterFirst = await ctx.prisma.providerCreditTransaction.count();

    await manualRefund(offerId!, 409);
    await backdateOfferSubmission(ctx.prisma, offerId!, 72);
    const worker = await ctx.app.get(UnviewedOfferRefundService).execute();
    expect(worker.results.filter((row) => row.status === 'REFUNDED')).toHaveLength(0);

    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(rowsAfterFirst);
    expect(await lot(granted.lot.id)).toMatchObject({ remainingCredits: 2, status: 'ACTIVE' });
    expect((await consumptionsOf(await spendRowOf(offerId!)))[0]).toMatchObject({ status: 'REFUNDED', refundedCredits: 2 });
    const state = await expectInvariant(fixture.provider.id);
    expect(state).toMatchObject({ balance: 3, paid: 1, promoInWallet: 2 });
  });

  it('refuses a second consumption row for the same lot and debit in the database itself', async () => {
    const fixture = await providerFixture({ categoryCost: 1, paid: 0 });
    const granted = await createPromoLotFixture(ctx.prisma, fixture.provider.id, { credits: 2 });
    const { offerId } = await submitOffer(fixture);
    const spendId = await spendRowOf(offerId!);
    await expect(
      ctx.prisma.promoCreditLotConsumption.create({ data: { lotId: granted.lot.id, creditTransactionId: spendId!, consumedCredits: 1 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
