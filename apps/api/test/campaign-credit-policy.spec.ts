import { randomUUID } from 'node:crypto';
import {
  AdminPermission,
  type CampaignAdminDeductPolicy,
  type CampaignCreditSpendPriority,
  CampaignRevokeReason,
  Prisma,
  PromoCreditLotStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  debitWallet,
  expirePromoCreditLot,
  planWalletDebit,
  restorePromoConsumptionsForRefund,
  revokePromoCreditLot,
  WalletInvariantViolation,
  type WalletLot,
} from '../src/modules/credits/promo-credit-ledger';
import { createCampaignFixture, createPromoLotFixture, walletInvariant } from './campaign-fixtures';
import {
  ACCEPT_OFFER,
  backdateOfferSubmission,
  createAdminWithPermissions,
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
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';

/**
 * CAMPAIGN-CREDIT-POLICY-001 — per-version credit policy, the canonical wallet
 * debit waterfall, ADMIN_DEDUCT semantics and manual-credit idempotency.
 *
 * The planner is exercised as a pure function for the combinatorics; every
 * accounting claim that touches rows is then made through the real HTTP
 * routes (offer submit, acceptance recharge, admin deduct) or the real
 * primitives (revoke, expiry), and every row-touching scenario ends on the
 * wallet invariant `balance = paid + Σ promo remaining`, `paid ≥ 0`.
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

const DAY = 86_400_000;
const NOW = new Date('2026-10-05T12:00:00.000Z');
const inDays = (days: number, from = Date.now()) => new Date(from + days * DAY);

type Policy = { spendPriority: CampaignCreditSpendPriority; adminDeductPolicy: CampaignAdminDeductPolicy };
const COMBINATIONS: Policy[] = [
  { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' },
  { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' },
  { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' },
  { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' },
];

function walletLot(id: string, remainingCredits: number, policy: Policy, expiresInDays = 30, overrides: Partial<WalletLot> = {}): WalletLot {
  return {
    id,
    remainingCredits,
    expiresAt: inDays(expiresInDays, NOW.getTime()),
    status: PromoCreditLotStatus.ACTIVE,
    ...policy,
    ...overrides,
  };
}

function plan(input: { balance: number; lots: WalletLot[]; amount: number; purpose: 'OFFER_SPEND' | 'ADMIN_DEDUCT' }) {
  return planWalletDebit({ ...input, now: NOW });
}

// ─────────────────────────── the planner (pure) ───────────────────────────

describe('planWalletDebit — the canonical waterfall', () => {
  describe.each(COMBINATIONS)('one lot of $spendPriority + $adminDeductPolicy', (policy) => {
    it('promo only: an offer spend takes the lot whatever its priority (nothing else can pay)', () => {
      const result = plan({ balance: 5, lots: [walletLot('a', 5, policy)], amount: 3, purpose: 'OFFER_SPEND' });
      expect(result.ok && result.plan).toMatchObject({ paidShare: 0, promoShares: [{ lotId: 'a', credits: 3, exhausts: false }] });
    });

    it('paid only: no lot, the paid pool pays, for both purposes', () => {
      for (const purpose of ['OFFER_SPEND', 'ADMIN_DEDUCT'] as const) {
        const result = plan({ balance: 4, lots: [], amount: 4, purpose });
        expect(result.ok && result.plan).toMatchObject({ paidShare: 4, promoShares: [] });
      }
    });

    it('mixed: an offer spend takes promo before paid only when PROMO_FIRST', () => {
      const result = plan({ balance: 10, lots: [walletLot('a', 5, policy)], amount: 3, purpose: 'OFFER_SPEND' });
      if (!result.ok) throw new Error('refused');
      if (policy.spendPriority === 'PROMO_FIRST') {
        expect(result.plan).toMatchObject({ paidShare: 0, promoShares: [{ lotId: 'a', credits: 3 }] });
      } else {
        expect(result.plan).toMatchObject({ paidShare: 3, promoShares: [] });
      }
    });

    it('mixed, beyond paid: a PAID_FIRST lot pays only what paid cannot', () => {
      const result = plan({ balance: 10, lots: [walletLot('a', 5, policy)], amount: 7, purpose: 'OFFER_SPEND' });
      if (!result.ok) throw new Error('refused');
      if (policy.spendPriority === 'PROMO_FIRST') {
        expect(result.plan).toMatchObject({ paidShare: 2, promoShares: [{ lotId: 'a', credits: 5, exhausts: true }] });
      } else {
        expect(result.plan).toMatchObject({ paidShare: 5, promoShares: [{ lotId: 'a', credits: 2, exhausts: false }] });
      }
    });

    it('mixed: an admin deduction takes the lot only when ALLOW_PROMO, in the same tier order', () => {
      const result = plan({ balance: 10, lots: [walletLot('a', 5, policy)], amount: 7, purpose: 'ADMIN_DEDUCT' });
      if (policy.adminDeductPolicy === 'PAID_ONLY') {
        expect(result).toMatchObject({ ok: false, reason: 'EXCEEDS_DEDUCTIBLE', breakdown: { deductibleCredits: 5, promoProtectedCredits: 5, paidCredits: 5 } });
        return;
      }
      if (!result.ok) throw new Error('refused');
      expect(result.plan.promoShares).toHaveLength(1);
      expect(result.plan.paidShare + result.plan.promoShares[0]!.credits).toBe(7);
      expect(result.plan.paidShare).toBe(policy.spendPriority === 'PROMO_FIRST' ? 2 : 5);
    });
  });

  it('several campaigns: PROMO_FIRST lots (by expiry), then paid, then PAID_FIRST lots (by expiry)', () => {
    const lots = [
      walletLot('A', 15, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' }, 5),
      walletLot('B', 10, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' }, 3),
      walletLot('C', 10, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' }, 10),
      walletLot('D', 5, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' }, 1),
    ];
    // balance = paid 10 + promo 40
    const spend30 = plan({ balance: 50, lots, amount: 30, purpose: 'OFFER_SPEND' });
    expect(spend30.ok && spend30.plan).toMatchObject({
      paidShare: 5,
      promoShares: [
        { lotId: 'B', credits: 10, exhausts: true },
        { lotId: 'A', credits: 15, exhausts: true },
      ],
    });
    // PAID_FIRST lots pay only after paid is gone — D (sooner expiry) before C.
    const spend45 = plan({ balance: 50, lots, amount: 45, purpose: 'OFFER_SPEND' });
    expect(spend45.ok && spend45.plan.promoShares.map((share) => [share.lotId, share.credits])).toEqual([
      ['B', 10],
      ['A', 15],
      ['D', 5],
      ['C', 5],
    ]);
    expect(spend45.ok && spend45.plan.paidShare).toBe(10);

    const deduct30 = plan({ balance: 50, lots, amount: 30, purpose: 'ADMIN_DEDUCT' });
    expect(deduct30.ok && deduct30.plan).toMatchObject({
      paidShare: 10,
      promoShares: [
        { lotId: 'A', credits: 15 },
        { lotId: 'C', credits: 5 },
      ],
    });
    const deduct40 = plan({ balance: 50, lots, amount: 40, purpose: 'ADMIN_DEDUCT' });
    expect(deduct40).toMatchObject({
      ok: false,
      reason: 'EXCEEDS_DEDUCTIBLE',
      breakdown: { balance: 50, paidCredits: 10, deductibleCredits: 35, promoProtectedCredits: 15 },
    });
  });

  it('breaks an equal expiry by id, by code unit — the same order on every run and every collation', () => {
    const policy: Policy = { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' };
    const lots = [walletLot('lot-b', 2, policy, 7), walletLot('Lot-z', 2, policy, 7), walletLot('lot-a', 2, policy, 7)];
    const result = plan({ balance: 6, lots, amount: 5, purpose: 'OFFER_SPEND' });
    expect(result.ok && result.plan.promoShares.map((share) => share.lotId)).toEqual(['Lot-z', 'lot-a', 'lot-b']);
  });

  it('never draws on an expired (unswept), revoked, expired or exhausted lot, and counts the unswept one out of what can pay', () => {
    const policy: Policy = { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' };
    const lots = [
      walletLot('due', 4, policy, -1),
      walletLot('revoked', 0, policy, 9, { status: PromoCreditLotStatus.REVOKED }),
      walletLot('expired', 0, policy, 9, { status: PromoCreditLotStatus.EXPIRED }),
      walletLot('empty', 0, policy, 9, { status: PromoCreditLotStatus.EXHAUSTED }),
      walletLot('live', 2, policy, 9),
    ];
    // balance = paid 1 + live 2 + due 4
    const result = plan({ balance: 7, lots, amount: 3, purpose: 'OFFER_SPEND' });
    expect(result.ok && result.plan).toMatchObject({ paidShare: 1, promoShares: [{ lotId: 'live', credits: 2 }] });
    expect(result.ok && result.plan.breakdown).toMatchObject({ promoUnsweptExpiredCredits: 4, spendableCredits: 3 });
    expect(plan({ balance: 7, lots, amount: 4, purpose: 'OFFER_SPEND' })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_SPENDABLE' });
    expect(plan({ balance: 7, lots, amount: 8, purpose: 'ADMIN_DEDUCT' })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_BALANCE' });
  });

  it('fails closed when the promo inside the wallet exceeds the balance (paid < 0)', () => {
    const lots = [walletLot('a', 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' })];
    expect(() => plan({ balance: 4, lots, amount: 1, purpose: 'OFFER_SPEND' })).toThrow(WalletInvariantViolation);
  });
});

// ─────────────────────────── fixtures (rows) ───────────────────────────

async function providerWithCategory(cost = 1) {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: cost });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
  const cookie = await loginAs(ctx.prisma, owner.id);
  return { category, owner, provider, cookie };
}

async function lotOf(providerId: string, credits: number, policy: Policy, expiresAt = inDays(30)) {
  return createPromoLotFixture(ctx.prisma, providerId, { credits, expiresAt, ...policy });
}

async function submitOffer(fixture: { category: { id: string }; provider: { id: string }; cookie: string }, expected = 201) {
  const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id });
  const response = await request(ctx.server)
    .post(`/providers/${fixture.provider.id}/requests/${serviceRequest.id}/offers`)
    .set('Cookie', fixture.cookie)
    .send(offerPayload());
  expect(response.status).toBe(expected);
  return { serviceRequest, offerId: response.body.id as string | undefined };
}

async function adminSession() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

function deduct(cookie: string, providerId: string, amount: number, idempotencyKey: string = randomUUID(), reason = 'Politika testi kesintisi') {
  return request(ctx.server).post(`/providers/${providerId}/credits/deduct`).set('Cookie', cookie).send({ amount, reason, idempotencyKey });
}

function grant(cookie: string, providerId: string, amount: number, idempotencyKey: string = randomUUID(), reason = 'Politika testi ekleme') {
  return request(ctx.server).post(`/providers/${providerId}/credits/grant`).set('Cookie', cookie).send({ amount, reason, idempotencyKey });
}

async function expectInvariant(providerId: string) {
  const state = await walletInvariant(ctx.prisma, providerId);
  expect(state.sumOfAmounts).toBe(state.balance);
  expect(state.paid).toBeGreaterThanOrEqual(0);
  expect(state.balance).toBeGreaterThanOrEqual(0);
  // Every lot's books close: granted = remaining + Σ consumed-not-refunded (+ what expiry/revoke took).
  const lots = await ctx.prisma.promoCreditLot.findMany({ where: { providerId }, include: { consumptions: true } });
  for (const lot of lots) {
    const consumedNet = lot.consumptions.reduce((total, share) => total + share.consumedCredits - share.refundedCredits, 0);
    expect(lot.remainingCredits).toBeGreaterThanOrEqual(0);
    expect(consumedNet).toBeLessThanOrEqual(lot.grantedCredits);
    if (lot.status === 'ACTIVE' || lot.status === 'EXHAUSTED') {
      expect(lot.remainingCredits + consumedNet).toBe(lot.grantedCredits);
    }
  }
  return state;
}

async function writeCounts() {
  return {
    ledger: await ctx.prisma.providerCreditTransaction.count(),
    consumptions: await ctx.prisma.promoCreditLotConsumption.count(),
    manual: await ctx.prisma.manualCreditOperation.count(),
    lots: await ctx.prisma.promoCreditLot.findMany({ orderBy: { id: 'asc' }, select: { id: true, remainingCredits: true, status: true } }),
  };
}

function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return ctx.prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// ─────────────────────────── OFFER_SPEND ───────────────────────────

describe('OFFER_SPEND through the offer route', () => {
  it('PROMO_FIRST and PAID_FIRST lots together: PROMO_FIRST first, then paid, then PAID_FIRST — partial lots stay ACTIVE', async () => {
    const fixture = await providerWithCategory(4);
    const promoFirst = await lotOf(fixture.provider.id, 3, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    const paidFirst = await lotOf(fixture.provider.id, 5, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' }, inDays(2));
    await grantCredits(ctx.prisma, fixture.provider.id, 2);

    // cost 4: PROMO_FIRST 3, paid 1 — the sooner-expiring PAID_FIRST lot waits.
    const first = await submitOffer(fixture);
    const firstSpend = (await ctx.prisma.offer.findUniqueOrThrow({ where: { id: first.offerId! } })).creditSpentTransactionId!;
    const firstShares = await ctx.prisma.promoCreditLotConsumption.findMany({ where: { creditTransactionId: firstSpend } });
    expect(firstShares).toEqual([expect.objectContaining({ lotId: promoFirst.lot.id, consumedCredits: 3, source: 'OFFER_SPEND' })]);
    expect(await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: promoFirst.lot.id } })).toMatchObject({ remainingCredits: 0, status: 'EXHAUSTED' });
    expect(await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: paidFirst.lot.id } })).toMatchObject({ remainingCredits: 5, status: 'ACTIVE' });
    expect(await expectInvariant(fixture.provider.id)).toMatchObject({ balance: 6, paid: 1, promoInWallet: 5 });

    // cost 4 again: paid 1, then PAID_FIRST 3 — partial.
    const second = await submitOffer(fixture);
    const secondSpend = (await ctx.prisma.offer.findUniqueOrThrow({ where: { id: second.offerId! } })).creditSpentTransactionId!;
    expect(await ctx.prisma.promoCreditLotConsumption.findMany({ where: { creditTransactionId: secondSpend } })).toEqual([
      expect.objectContaining({ lotId: paidFirst.lot.id, consumedCredits: 3 }),
    ]);
    expect(await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: paidFirst.lot.id } })).toMatchObject({ remainingCredits: 2, status: 'ACTIVE' });
    expect(await expectInvariant(fixture.provider.id)).toMatchObject({ balance: 2, paid: 0, promoInWallet: 2 });

    // Not enough left for a third: 402, nothing written.
    const before = await writeCounts();
    await submitOffer(fixture, 402);
    expect(await writeCounts()).toEqual(before);
  });

  it('a refund puts each share back where it came from (paid share into paid, promo share into its valid lot)', async () => {
    const fixture = await providerWithCategory(4);
    const paidFirst = await lotOf(fixture.provider.id, 5, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    await grantCredits(ctx.prisma, fixture.provider.id, 1);
    const { offerId } = await submitOffer(fixture);
    expect(await expectInvariant(fixture.provider.id)).toMatchObject({ balance: 2, paid: 0, promoInWallet: 2 });

    await backdateOfferSubmission(ctx.prisma, offerId!, 72);
    await ctx.app.get(UnviewedOfferRefundService).execute();

    expect(await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: paidFirst.lot.id } })).toMatchObject({ remainingCredits: 5 });
    expect(await expectInvariant(fixture.provider.id)).toMatchObject({ balance: 6, paid: 1, promoInWallet: 5 });
  });

  it('the acceptance recharge of a refunded offer is paid through the same waterfall', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 2 });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const { lot } = await lotOf(provider.id, 3, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    await grantCredits(ctx.prisma, provider.id, 1);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${serviceRequest.id}/offers`)
      .set('Cookie', cookie)
      .send(offerPayload())
      .expect(201);
    const offerId = created.body.id as string;
    await backdateOfferSubmission(ctx.prisma, offerId, 72);
    await ctx.app.get(UnviewedOfferRefundService).execute();
    expect(await expectInvariant(provider.id)).toMatchObject({ balance: 4, paid: 1, promoInWallet: 3 });

    await request(ctx.server).post(`/service-requests/${serviceRequest.id}/offers/${offerId}/action`).set('Cookie', customerCookie).send(ACCEPT_OFFER).expect(201);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    // Paid 1 first, then the PAID_FIRST lot 1.
    expect(await ctx.prisma.promoCreditLotConsumption.findMany({ where: { creditTransactionId: offer.creditRechargeTransactionId! } })).toEqual([
      expect.objectContaining({ lotId: lot.id, consumedCredits: 1, source: 'OFFER_SPEND' }),
    ]);
    expect(await expectInvariant(provider.id)).toMatchObject({ balance: 2, paid: 0, promoInWallet: 2 });
  });
});

// ─────────────────────────── ADMIN_DEDUCT ───────────────────────────

describe('ADMIN_DEDUCT', () => {
  it('takes paid credit and ALLOW_PROMO lots in waterfall order, never a PAID_ONLY lot; one ledger row; shares marked ADMIN_DEDUCT', async () => {
    const { provider } = await providerWithCategory();
    const allowFirst = await lotOf(provider.id, 4, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    const protectedLot = await lotOf(provider.id, 6, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' }, inDays(1));
    const allowLast = await lotOf(provider.id, 5, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    await grantCredits(ctx.prisma, provider.id, 3);
    const { cookie, admin } = await adminSession();

    const response = await deduct(cookie, provider.id, 9).expect(201);
    expect(response.body).toMatchObject({ type: 'ADMIN_DEDUCT', amount: -9, balanceAfter: 9, createdById: admin.id });
    const shares = await ctx.prisma.promoCreditLotConsumption.findMany({ where: { creditTransactionId: response.body.id }, orderBy: { consumedCredits: 'desc' } });
    expect(shares).toEqual([
      expect.objectContaining({ lotId: allowFirst.lot.id, consumedCredits: 4, source: 'ADMIN_DEDUCT', status: 'CONSUMED' }),
      expect.objectContaining({ lotId: allowLast.lot.id, consumedCredits: 2, source: 'ADMIN_DEDUCT', status: 'CONSUMED' }),
    ]);
    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: protectedLot.lot.id } })).remainingCredits).toBe(6);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { providerId: provider.id, type: 'ADMIN_DEDUCT' } })).toBe(1);
    expect(await expectInvariant(provider.id)).toMatchObject({ balance: 9, paid: 0, promoInWallet: 9 });
  });

  it('paid insufficient but total sufficient: 400 CREDIT_DEDUCT_EXCEEDS_DEDUCTIBLE with the figures, and nothing written', async () => {
    const { provider } = await providerWithCategory();
    await lotOf(provider.id, 10, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    await grantCredits(ctx.prisma, provider.id, 3);
    const { cookie } = await adminSession();
    const before = await writeCounts();

    const refused = await deduct(cookie, provider.id, 8).expect(400);
    expect(refused.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'CREDIT_DEDUCT_EXCEEDS_DEDUCTIBLE',
      message: expect.any(String),
      requestedCredits: 8,
      deductibleCredits: 3,
      paidCredits: 3,
      protectedPromoCredits: 10,
      balance: 13,
    });
    expect(await writeCounts()).toEqual(before);

    // What it may take, it takes — and the protected lot can still expire later
    // (the deduction no longer leaves a paid pool below zero to wedge it).
    await deduct(cookie, provider.id, 3).expect(201);
    const state = await expectInvariant(provider.id);
    expect(state).toMatchObject({ balance: 10, paid: 0, promoInWallet: 10 });
  });

  it('more than the whole balance: 400 CREDIT_BALANCE_INSUFFICIENT, the message the panel has always matched, nothing written', async () => {
    const { provider } = await providerWithCategory();
    await lotOf(provider.id, 2, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    await grantCredits(ctx.prisma, provider.id, 1);
    const { cookie } = await adminSession();
    const before = await writeCounts();
    const refused = await deduct(cookie, provider.id, 4).expect(400);
    expect(refused.body).toMatchObject({ code: 'CREDIT_BALANCE_INSUFFICIENT', requestedCredits: 4, balance: 3 });
    expect(refused.body.message).toContain('below zero');
    expect(await writeCounts()).toEqual(before);
  });

  it('a deducted promo share is final: a refund never settles it, and the database refuses to mark it refunded or forfeited', async () => {
    const { provider } = await providerWithCategory();
    const { lot } = await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    const { cookie } = await adminSession();
    const response = await deduct(cookie, provider.id, 2).expect(201);

    const outcome = await serializable((tx) =>
      restorePromoConsumptionsForRefund(tx, { providerId: provider.id, spendTransactionId: response.body.id, refundTransactionId: response.body.id, now: new Date() }),
    );
    expect(outcome).toEqual({ refunded: [], forfeited: [], balanceAfter: null });

    const share = await ctx.prisma.promoCreditLotConsumption.findFirstOrThrow({ where: { lotId: lot.id } });
    await expect(
      ctx.prisma.promoCreditLotConsumption.update({
        where: { id: share.id },
        data: { status: 'REFUNDED', refundedCredits: 2, refundTransactionId: response.body.id, settledAt: new Date() },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('PromoCreditLotConsumption_admin_deduct_final') });
  });

  it('deduct then revoke: the revoke takes only what is left, the deducted share stays CONSUMED', async () => {
    const { provider } = await providerWithCategory();
    const granted = await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    const { cookie, admin } = await adminSession();
    await deduct(cookie, provider.id, 2).expect(201);

    const revoked = await serializable((tx) =>
      revokePromoCreditLot(tx, { lotId: granted.lot.id, reason: CampaignRevokeReason.ADMIN_REVOKED, revokedById: admin.id, now: new Date() }),
    );
    expect(revoked).toMatchObject({ revoked: true, credits: 3 });
    expect(await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: granted.redemption.id } })).toMatchObject({ status: 'REVOKED', spentAtRevoke: 2 });
    expect(await ctx.prisma.promoCreditLotConsumption.findFirstOrThrow({ where: { lotId: granted.lot.id } })).toMatchObject({ status: 'CONSUMED', source: 'ADMIN_DEDUCT' });
    expect(await expectInvariant(provider.id)).toMatchObject({ balance: 0, paid: 0, promoInWallet: 0 });
  });

  it('deduct then expiry: the sweep takes the remainder and nothing wedges', async () => {
    const { provider } = await providerWithCategory();
    const granted = await lotOf(provider.id, 5, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' }, inDays(1));
    await grantCredits(ctx.prisma, provider.id, 2);
    const { cookie } = await adminSession();
    await deduct(cookie, provider.id, 4).expect(201); // paid 2, then the PAID_FIRST lot 2

    const expired = await serializable((tx) => expirePromoCreditLot(tx, { lotId: granted.lot.id, now: inDays(2) }));
    expect(expired).toMatchObject({ expired: true, credits: 3 });
    expect(await expectInvariant(provider.id)).toMatchObject({ balance: 0, paid: 0, promoInWallet: 0 });
  });

  it('a PAID_FIRST lot expires untouched while paid credit pays (expected behaviour)', async () => {
    const fixture = await providerWithCategory(1);
    const granted = await lotOf(fixture.provider.id, 3, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' }, inDays(1));
    await grantCredits(ctx.prisma, fixture.provider.id, 5);
    await submitOffer(fixture);
    await submitOffer(fixture);
    expect((await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: granted.lot.id } })).remainingCredits).toBe(3);
    await serializable((tx) => expirePromoCreditLot(tx, { lotId: granted.lot.id, now: inDays(2) }));
    expect(await expectInvariant(fixture.provider.id)).toMatchObject({ balance: 3, paid: 3, promoInWallet: 0 });
  });
});

// ─────────────────────────── idempotency ───────────────────────────

describe('manual credit idempotency (ADMIN_DEDUCT / ADMIN_GRANT)', () => {
  it('the scenario: a deduct commits, its answer is lost, the same operation is sent again — it is not deducted twice', async () => {
    const { provider } = await providerWithCategory();
    await grantCredits(ctx.prisma, provider.id, 10);
    const { cookie } = await adminSession();
    const key = randomUUID();

    const first = await deduct(cookie, provider.id, 4, key).expect(201);
    // The client never saw `first`; it retries the same operation (same key).
    // A fresh confirmation proof would pass the panel again — the API is what
    // must recognise the operation.
    const retry = await deduct(cookie, provider.id, 4, key).expect(201);

    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.balanceAfter).toBe(6);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(6);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { providerId: provider.id, type: 'ADMIN_DEDUCT' } })).toBe(1);
    expect(await ctx.prisma.manualCreditOperation.count()).toBe(1);
  });

  it('two concurrent first attempts with one key move the credit once and both answer the same row', async () => {
    const { provider } = await providerWithCategory();
    await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    await grantCredits(ctx.prisma, provider.id, 5);
    const { cookie } = await adminSession();
    const key = randomUUID();

    const responses = await Promise.all([deduct(cookie, provider.id, 6, key), deduct(cookie, provider.id, 6, key), deduct(cookie, provider.id, 6, key)]);
    for (const response of responses) expect(response.status).toBe(201);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { providerId: provider.id, type: 'ADMIN_DEDUCT' } })).toBe(1);
    expect(await ctx.prisma.promoCreditLotConsumption.count({ where: { source: 'ADMIN_DEDUCT' } })).toBe(1);
    expect(await expectInvariant(provider.id)).toMatchObject({ balance: 4 });
  });

  it('a key reused for a different operation is a 409 and writes nothing', async () => {
    const { provider } = await providerWithCategory();
    await grantCredits(ctx.prisma, provider.id, 10);
    const { cookie } = await adminSession();
    const key = randomUUID();
    await deduct(cookie, provider.id, 2, key).expect(201);
    const before = await writeCounts();

    for (const attempt of [
      () => deduct(cookie, provider.id, 3, key),
      () => deduct(cookie, provider.id, 2, key, 'Başka bir gerekçe'),
      () => grant(cookie, provider.id, 2, key),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    const otherAdmin = await adminSession();
    expect((await deduct(otherAdmin.cookie, provider.id, 2, key)).status).toBe(409);
    expect(await writeCounts()).toEqual(before);
  });

  it('separate operations need separate keys: two keys are two deductions', async () => {
    const { provider } = await providerWithCategory();
    await grantCredits(ctx.prisma, provider.id, 10);
    const { cookie } = await adminSession();
    await deduct(cookie, provider.id, 2).expect(201);
    await deduct(cookie, provider.id, 2).expect(201);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(6);
  });

  it('refuses a request without a well-formed key, before anything is written', async () => {
    const { provider } = await providerWithCategory();
    await grantCredits(ctx.prisma, provider.id, 10);
    const { cookie } = await adminSession();
    const before = await writeCounts();
    for (const idempotencyKey of [undefined, '', 'short', 'x'.repeat(129), 'has space in it 123456']) {
      const response = await request(ctx.server)
        .post(`/providers/${provider.id}/credits/deduct`)
        .set('Cookie', cookie)
        .send({ amount: 1, reason: 'anahtarsız deneme', idempotencyKey });
      expect(response.status).toBe(400);
    }
    expect(await writeCounts()).toEqual(before);
  });

  it('a grant is idempotent the same way and stays paid credit', async () => {
    const { provider } = await providerWithCategory();
    await lotOf(provider.id, 2, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    const { cookie } = await adminSession();
    const key = randomUUID();
    const first = await grant(cookie, provider.id, 5, key).expect(201);
    const retry = await grant(cookie, provider.id, 5, key).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(await expectInvariant(provider.id)).toMatchObject({ balance: 7, paid: 5, promoInWallet: 2 });
  });

  it('the idempotency record is append-only and must match its ledger row', async () => {
    const { provider } = await providerWithCategory();
    await grantCredits(ctx.prisma, provider.id, 10);
    const { cookie, admin } = await adminSession();
    const response = await deduct(cookie, provider.id, 2).expect(201);
    const record = await ctx.prisma.manualCreditOperation.findUniqueOrThrow({ where: { transactionId: response.body.id } });
    await expect(ctx.prisma.manualCreditOperation.update({ where: { id: record.id }, data: { requestedCredits: 3 } })).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.manualCreditOperation.delete({ where: { id: record.id } })).rejects.toThrow(/append-only/);

    const other = await ctx.prisma.providerCreditTransaction.findFirstOrThrow({ where: { providerId: provider.id, type: 'ADMIN_GRANT' } });
    await expect(
      ctx.prisma.manualCreditOperation.create({
        data: { idempotencyKey: randomUUID(), providerId: provider.id, type: 'ADMIN_DEDUCT', requestedCredits: 10, reason: 'x', actorId: admin.id, transactionId: other.id },
      }),
    ).rejects.toThrow(/does not match its ledger row/);
  });
});

// ─────────────────────────── races ───────────────────────────

describe('races', () => {
  it('parallel offer spends: no duplicate consumption, no negative pool, invariant holds', async () => {
    const fixture = await providerWithCategory(3);
    await lotOf(fixture.provider.id, 4, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    await lotOf(fixture.provider.id, 4, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    await grantCredits(ctx.prisma, fixture.provider.id, 3);
    const requests = await Promise.all(Array.from({ length: 4 }, () => createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id })));

    const responses = await Promise.all(
      requests.map((serviceRequest) =>
        request(ctx.server).post(`/providers/${fixture.provider.id}/requests/${serviceRequest.id}/offers`).set('Cookie', fixture.cookie).send(offerPayload()),
      ),
    );
    const created = responses.filter((response) => response.status === 201).length;
    for (const response of responses) expect([201, 402, 409]).toContain(response.status);
    const state = await expectInvariant(fixture.provider.id);
    expect(state.balance).toBe(11 - created * 3);
    const shares = await ctx.prisma.promoCreditLotConsumption.findMany();
    expect(new Set(shares.map((share) => `${share.lotId}:${share.creditTransactionId}`)).size).toBe(shares.length);
  });

  it('parallel deducts with different keys: never more than the deductible credit, never a negative pool', async () => {
    const { provider } = await providerWithCategory();
    await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    await grantCredits(ctx.prisma, provider.id, 3);
    const { cookie } = await adminSession();

    const responses = await Promise.all(Array.from({ length: 3 }, () => deduct(cookie, provider.id, 4)));
    const landed = responses.filter((response) => response.status === 201).length;
    for (const response of responses) expect([201, 400, 409]).toContain(response.status);
    expect(landed).toBeLessThanOrEqual(2); // deductible was 8
    const state = await expectInvariant(provider.id);
    expect(state.balance).toBe(13 - landed * 4);
    expect(state.promoInWallet).toBeGreaterThanOrEqual(5); // the PAID_ONLY lot is whole
  });

  it('offer spend against a revoke of the lot it draws on: one serial order, books close either way', async () => {
    const fixture = await providerWithCategory(2);
    const granted = await lotOf(fixture.provider.id, 3, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    await grantCredits(ctx.prisma, fixture.provider.id, 2);
    const { admin } = await adminSession();
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: fixture.category.id });

    const [spend] = await Promise.allSettled([
      request(ctx.server).post(`/providers/${fixture.provider.id}/requests/${serviceRequest.id}/offers`).set('Cookie', fixture.cookie).send(offerPayload()),
      serializable((tx) => revokePromoCreditLot(tx, { lotId: granted.lot.id, reason: CampaignRevokeReason.ADMIN_REVOKED, revokedById: admin.id, now: new Date() })).catch(
        () => null,
      ),
    ]);
    expect(spend.status).toBe('fulfilled');
    const state = await expectInvariant(fixture.provider.id);
    expect(state.promoInWallet).toBeLessThanOrEqual(3);
    const lot = await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: granted.lot.id } });
    expect(['REVOKED', 'ACTIVE']).toContain(lot.status);
  });

  it('deduct against revoke and against expiry of the same lot: books close either way', async () => {
    const { provider } = await providerWithCategory();
    const first = await lotOf(provider.id, 4, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' }, inDays(1));
    const second = await lotOf(provider.id, 4, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' }, inDays(1));
    await grantCredits(ctx.prisma, provider.id, 1);
    const { cookie, admin } = await adminSession();

    await Promise.allSettled([
      deduct(cookie, provider.id, 3),
      serializable((tx) => revokePromoCreditLot(tx, { lotId: first.lot.id, reason: CampaignRevokeReason.ADMIN_REVOKED, revokedById: admin.id, now: new Date() })),
    ]);
    await expectInvariant(provider.id);

    await Promise.allSettled([
      deduct(cookie, provider.id, 2),
      serializable((tx) => expirePromoCreditLot(tx, { lotId: second.lot.id, now: inDays(2) })),
    ]);
    await expectInvariant(provider.id);
  });
});

// ─────────────────────────── database guarantees ───────────────────────────

describe('immutable policy and lot snapshot (database)', () => {
  it('a lot carries the policy of the version it was granted under, and a later version changes nothing about it', async () => {
    const { provider } = await providerWithCategory();
    const granted = await lotOf(provider.id, 5, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    expect(granted.lot).toMatchObject({ spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    const next = await createCampaignFixture(ctx.prisma, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    expect(next.version.spendPriority).toBe('PROMO_FIRST');
    expect(await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: granted.lot.id } })).toMatchObject({ spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
  });

  it('refuses to change a version policy, a lot policy or a consumption source', async () => {
    const { provider } = await providerWithCategory();
    const granted = await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    const { cookie } = await adminSession();
    const response = await deduct(cookie, provider.id, 1).expect(201);

    await expect(ctx.prisma.campaignVersion.update({ where: { id: granted.version.id }, data: { spendPriority: 'PAID_FIRST' } })).rejects.toThrow(/never changed/);
    await expect(ctx.prisma.promoCreditLot.update({ where: { id: granted.lot.id }, data: { adminDeductPolicy: 'PAID_ONLY' } })).rejects.toThrow(/never changed/);
    const share = await ctx.prisma.promoCreditLotConsumption.findFirstOrThrow({ where: { creditTransactionId: response.body.id } });
    await expect(ctx.prisma.promoCreditLotConsumption.update({ where: { id: share.id }, data: { source: 'OFFER_SPEND' } })).rejects.toThrow(/never changed/);
  });

  it('refuses a version whose JSON policy disagrees with its columns, or a credit version without a policy', async () => {
    const granted = await createCampaignFixture(ctx.prisma);
    const definition = granted.version.definition as { benefit: Record<string, unknown> };
    await expect(
      ctx.prisma.campaignVersion.update({
        where: { id: granted.version.id },
        data: { definition: { ...definition, benefit: { ...definition.benefit, creditPolicy: { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' } } } as Prisma.InputJsonValue },
      }),
    ).rejects.toThrow(/CampaignVersion_credit_policy_matches_definition/);

    const { id: _id, createdAt: _c, ...row } = granted.version;
    await expect(
      ctx.prisma.campaignVersion.create({
        data: { ...row, versionNumber: 2, definition: row.definition as Prisma.InputJsonValue, spendPriority: null, adminDeductPolicy: null } as Prisma.CampaignVersionUncheckedCreateInput,
      }),
    ).rejects.toThrow(/CampaignVersion_credit_policy_matches_benefit/);
  });

  it('refuses a lot whose policy is not its version’s, and a consumption whose source is not its debit’s type', async () => {
    const { provider } = await providerWithCategory();
    const granted = await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    const event = await ctx.prisma.campaignTriggerEvent.create({ data: { triggerEventKey: `PROVIDER_APPROVED:${provider.id}:x`, trigger: 'PROVIDER_APPROVED', providerId: provider.id } });
    const redemption = await ctx.prisma.campaignRedemption.create({
      data: {
        campaignId: granted.campaign.id,
        campaignVersionId: granted.version.id,
        providerId: provider.id,
        trigger: 'PROVIDER_APPROVED',
        triggerEventId: event.id,
        triggerEventKey: event.triggerEventKey,
        rulesSnapshot: {},
        grantedCredits: 1,
      },
    });
    await expect(
      ctx.prisma.promoCreditLot.create({
        data: { providerId: provider.id, redemptionId: redemption.id, grantedCredits: 1, remainingCredits: 1, expiresAt: inDays(5), spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' },
      }),
    ).rejects.toThrow(/must equal the policy/);

    await grantCredits(ctx.prisma, provider.id, 1);
    const grantRow = await ctx.prisma.providerCreditTransaction.findFirstOrThrow({ where: { providerId: provider.id, type: 'ADMIN_GRANT' } });
    await expect(
      ctx.prisma.promoCreditLotConsumption.create({ data: { lotId: granted.lot.id, creditTransactionId: grantRow.id, consumedCredits: 1, source: 'OFFER_SPEND' } }),
    ).rejects.toThrow(/does not match its ledger row type/);
  });

  it('debitWallet refuses a wallet whose paid pool is already below zero and writes nothing', async () => {
    const { provider } = await providerWithCategory();
    await lotOf(provider.id, 5, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    // A drifted wallet, as a pre-fix ADMIN_DEDUCT could leave it: −3 not booked against any pool.
    await ctx.prisma.providerCreditTransaction.create({ data: { providerId: provider.id, type: 'ADMIN_DEDUCT', amount: -3, balanceAfter: 2 } });
    const before = await writeCounts();
    await expect(
      serializable((tx) =>
        debitWallet(tx, { providerId: provider.id, amount: 1, purpose: 'OFFER_SPEND', now: new Date(), ledger: { reason: null, referenceType: null, referenceId: null, createdById: null } }),
      ),
    ).rejects.toBeInstanceOf(WalletInvariantViolation);
    expect(await writeCounts()).toEqual(before);

    const { cookie } = await adminSession();
    const refused = await deduct(cookie, provider.id, 1);
    expect(refused.status).toBe(500);
    expect(refused.body.code).toBe('WALLET_INVARIANT_VIOLATION');
  });
});

// ─────────────────────────── admin read projection ───────────────────────────

describe('admin read projections', () => {
  it('the provider credit read carries the wallet split as aggregates only, to a ledger reader', async () => {
    const { provider } = await providerWithCategory();
    const granted = await lotOf(provider.id, 4, { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    await lotOf(provider.id, 6, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    await grantCredits(ctx.prisma, provider.id, 3);
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.FINANCE_LEDGER_READ]);
    const cookie = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server).get(`/admin/providers/${provider.id}/credits`).set('Cookie', cookie).expect(200);
    expect(response.body.balance).toBe(13);
    expect(response.body.walletBreakdown).toEqual({
      paidCredits: 3,
      promoDeductibleCredits: 4,
      promoProtectedCredits: 6,
      promoUnsweptExpiredCredits: 0,
      deductibleCredits: 7,
    });
    expect(response.body.walletBreakdownError).toBeNull();
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(granted.campaign.id);
    expect(body).not.toContain(granted.lot.id);
    expect(body).not.toContain('Kampanya');
  });

  it('campaign version detail carries both policy columns', async () => {
    const granted = await createCampaignFixture(ctx.prisma, { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    const { cookie } = await adminSession();
    const response = await request(ctx.server).get(`/admin/campaigns/${granted.campaign.id}`).set('Cookie', cookie).expect(200);
    expect(response.body.currentVersion).toMatchObject({ spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    expect(response.body.currentVersion.definition.benefit.creditPolicy).toEqual({ spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
  });

  it('a new version with another policy is a new row; the old row and its lots keep theirs; the audit names the change', async () => {
    const { cookie } = await adminSession();
    const base = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', status: 'DRAFT' });
    const definition = base.version.definition as { benefit: Record<string, unknown> } & Record<string, unknown>;
    const revised = await request(ctx.server)
      .post(`/admin/campaigns/${base.campaign.id}/versions`)
      .set('Cookie', cookie)
      .send({ definition: { ...definition, benefit: { ...definition.benefit, creditPolicy: { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' } } } })
      .expect(201);
    expect(revised.body.currentVersion).toMatchObject({ versionNumber: 2, spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
    expect(await ctx.prisma.campaignVersion.findUniqueOrThrow({ where: { id: base.version.id } })).toMatchObject({ spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
    const audit = await ctx.prisma.campaignAuditLog.findFirstOrThrow({ where: { campaignId: base.campaign.id, action: 'VERSION_CREATED' }, orderBy: { createdAt: 'desc' } });
    expect(audit.summary).toMatchObject({
      versionNumber: 2,
      creditPolicy: { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' },
      changedFields: ['benefit', 'creditPolicy'],
    });
  });
});
