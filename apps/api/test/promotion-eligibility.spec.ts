import {
  AdminPermission,
  CampaignTriggerEventStatus,
  OfferPackageType,
  PackagePurchaseStatus,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSerializable } from '../src/common/serializable-transaction';
import { CampaignEngineService } from '../src/modules/campaigns/engine/campaign-engine.service';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { createCampaignFixture, setEngineEnabled } from './campaign-fixtures';
import {
  createAdminWithPermissions,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  declareBusinessRegistration,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * PROVIDER_PROMOTION_ELIGIBLE in front of the engine, through the worker and
 * the real routes (CMP-006 PR-C design §2): the hold and its frozen snapshot,
 * the worker never claiming a held event, a person's decision — once — and
 * the registration counter that only a real grant moves.
 */

let ctx: TestContext;
let worker: CampaignEvaluationWorker;
let engine: CampaignEngineService;

beforeAll(async () => {
  ctx = await createTestApp();
  worker = ctx.app.get(CampaignEvaluationWorker);
  engine = ctx.app.get(CampaignEngineService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await setEngineEnabled(ctx.prisma, true);
});

const TCKN = '10000000146';

let adminCookie: string;

async function rootCookie() {
  if (!adminCookie || !(await ctx.prisma.session.findFirst({ where: { id: adminCookie.split('=')[1] } }))) {
    const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    adminCookie = await loginAs(ctx.prisma, root.id);
  }
  return adminCookie;
}

type RegistrationOption = { type: 'TAX_NUMBER' | 'SOLE_PROPRIETOR_TR_ID' | 'NONE_DECLARED'; number?: string } | 'unspecified';

/** A provider under review, both proofs on file unless told otherwise, and a registration as asked. */
async function applicant(options: { registration?: RegistrationOption; email?: boolean; phone?: boolean; ip?: string } = {}) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: `0555${uniqueSuffix().padStart(7, '0').slice(-7)}` });
  await ctx.prisma.user.update({
    where: { id: owner.id },
    data: {
      emailVerifiedAt: options.email === false ? null : new Date(),
      phoneVerifiedAt: options.phone === false ? null : new Date(),
    },
  });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.PENDING_REVIEW });
  const registration = options.registration ?? { type: 'TAX_NUMBER' };
  if (registration !== 'unspecified') {
    await declareBusinessRegistration(ctx.prisma, provider.id, { type: registration.type, number: registration.number });
  }
  if (options.ip) {
    await ctx.prisma.session.create({
      data: { id: `s-${uniqueSuffix()}-${Date.now()}`, userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000), ipAddress: options.ip },
    });
  }
  return { owner, provider };
}

async function setStatus(providerId: string, status: ProviderStatus) {
  await request(ctx.server).patch(`/providers/${providerId}/status`).set('Cookie', await rootCookie()).send({ status }).expect(200);
}

const approve = (providerId: string) => setStatus(providerId, ProviderStatus.APPROVED);

/** A suspension and a re-approval: the same PROVIDER_APPROVED key raised again. */
async function reRaise(providerId: string) {
  await setStatus(providerId, ProviderStatus.SUSPENDED);
  await approve(providerId);
}

async function eventOf(providerId: string) {
  return ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { triggerEventKey: `PROVIDER_APPROVED:${providerId}` } });
}

async function reviewer() {
  const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.PROMOTION_ELIGIBILITY_REVIEW]);
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

const decide = (cookie: string, eventId: string, body: Record<string, unknown>) =>
  request(ctx.server).post(`/admin/promotion-eligibility/holds/${eventId}/decision`).set('Cookie', cookie).send(body);

const REASON = 'Aynı işletmenin ikinci şubesi; belgeler kontrol edildi.';

async function campaignCounters(campaignId: string) {
  const row = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { redemptionCount: true, budgetConsumedCredits: true } });
  return {
    ...row,
    perProvider: await ctx.prisma.campaignProviderCounter.count({ where: { campaignId } }),
    perDay: await ctx.prisma.campaignDailyCounter.count({ where: { campaignId } }),
  };
}

describe('the gate on the introductory triggers', () => {
  it('same registration on two providers: the first is granted and counted, the second is held with a reason — not refused', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', credits: 10, maxRedemptionsGlobal: 100 });
    const first = await applicant({ registration: { type: 'SOLE_PROPRIETOR_TR_ID', number: TCKN } });
    await approve(first.provider.id);
    await worker.runOnce();
    // The second account declares the same number only after the first was granted
    // (two accounts declaring it at once would hold both: REGISTRATION_SHARED).
    const second = await applicant({ registration: { type: 'SOLE_PROPRIETOR_TR_ID', number: TCKN } });
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: first.provider.id } })).toBe(1);
    const counter = await ctx.prisma.campaignRegistrationCounter.findFirstOrThrow();
    expect(counter).toMatchObject({ providerId: first.provider.id, registrationType: 'SOLE_PROPRIETOR_TR_ID', redemptionCount: 1, fingerprintVersion: 1 });
    const before = await campaignCounters(campaign.id);

    await approve(second.provider.id);
    const pass = await worker.runOnce();
    expect(pass.outcomes).toEqual([{ triggerEventKey: `PROVIDER_APPROVED:${second.provider.id}`, outcome: 'HELD_FOR_REVIEW' }]);

    const event = await eventOf(second.provider.id);
    expect(event.status).toBe(CampaignTriggerEventStatus.HELD_FOR_REVIEW);
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: second.provider.id } })).toBe(0);
    expect(await campaignCounters(campaign.id)).toEqual(before);
    expect(await ctx.prisma.campaignRegistrationCounter.count()).toBe(1);

    const hold = await ctx.prisma.promotionEligibilityHold.findUniqueOrThrow({ where: { triggerEventId: event.id } });
    expect(hold.signals).toEqual({
      outcome: 'REVIEW',
      signals: [
        { code: 'REGISTRATION_PROMOTION_CONSUMED', registrationType: 'SOLE_PROPRIETOR_TR_ID', fingerprintVersion: 1, otherProviderIds: [first.provider.id] },
        { code: 'REGISTRATION_SHARED', registrationType: 'SOLE_PROPRIETOR_TR_ID', fingerprintVersion: 1, otherProviderIds: [first.provider.id] },
      ],
    });
    // No raw number anywhere the gate wrote.
    const written = JSON.stringify([
      await ctx.prisma.promotionEligibilityHold.findMany(),
      await ctx.prisma.campaignRegistrationCounter.findMany(),
      await ctx.prisma.campaignEvaluationLog.findMany(),
      await ctx.prisma.campaignTriggerEvent.findMany(),
    ]);
    expect(written).not.toContain(TCKN);
    expect(await ctx.prisma.campaignEvaluationLog.findMany({ where: { triggerEventId: event.id } })).toMatchObject([
      { campaignId: campaign.id, outcome: 'PROMOTION_REVIEW_HELD', reasonCode: 'REGISTRATION_PROMOTION_CONSUMED' },
    ]);
  });

  it('two accounts declaring the same registration are both held (REGISTRATION_SHARED) before either is granted', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const a = await applicant({ registration: { type: 'TAX_NUMBER', number: '5555555555' } });
    const b = await applicant({ registration: { type: 'TAX_NUMBER', number: '5555555555' } });
    await approve(a.provider.id);
    await approve(b.provider.id);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    const holds = await ctx.prisma.promotionEligibilityHold.findMany({ orderBy: { providerId: 'asc' } });
    expect(holds.map((hold) => (hold.signals as { signals: Array<{ code: string }> }).signals.map((entry) => entry.code))).toEqual([
      ['REGISTRATION_SHARED'],
      ['REGISTRATION_SHARED'],
    ]);
  });

  it('the same address alone is never a hold, let alone a refusal: both providers are granted', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', credits: 10 });
    const a = await applicant({ ip: '198.51.100.20' });
    const b = await applicant({ ip: '198.51.100.20' });
    await approve(a.provider.id);
    await approve(b.provider.id);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count()).toBe(2);
    expect(await ctx.prisma.promotionEligibilityHold.count()).toBe(0);
  });

  it('beside another reason the shared address is recorded — as a keyed fingerprint, never the address', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', credits: 10 });
    const a = await applicant({ ip: '198.51.100.20' });
    const b = await applicant({ ip: '198.51.100.20', registration: { type: 'NONE_DECLARED' } });
    await approve(b.provider.id);
    await worker.runOnce();

    const hold = await ctx.prisma.promotionEligibilityHold.findFirstOrThrow();
    const signals = (hold.signals as { signals: Array<Record<string, unknown>> }).signals;
    expect(signals.map((entry) => entry.code)).toEqual(['REGISTRATION_NONE_DECLARED', 'SHARED_IP']);
    expect(signals[1]).toMatchObject({ otherProviderIds: [a.provider.id] });
    expect(signals[1]!.ipFingerprints).toEqual([expect.stringMatching(/^v1:[0-9a-f]{64}$/)]);
    expect(JSON.stringify(hold)).not.toContain('198.51.100.20');
  });

  it.each([
    [{ type: 'NONE_DECLARED' } as const, 'REGISTRATION_NONE_DECLARED'],
    ['unspecified' as const, 'REGISTRATION_UNSPECIFIED'],
  ])('%o is held for a person (%s), not refused', async (registration, code) => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { provider } = await applicant({ registration });
    await approve(provider.id);
    await worker.runOnce();
    expect((await eventOf(provider.id)).status).toBe('HELD_FOR_REVIEW');
    expect(await ctx.prisma.promotionEligibilityHold.findFirstOrThrow()).toMatchObject({
      providerId: provider.id,
      signals: { outcome: 'REVIEW', signals: [{ code }] },
    });
  });

  it('a settled package refund is a reason for a person, not a refusal', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { provider } = await applicant();
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: 5, priceAmount: 10_000 });
    await ctx.prisma.packagePurchase.create({
      data: {
        providerId: provider.id,
        packageId: pkg.id,
        status: PackagePurchaseStatus.REFUNDED,
        creditAmountSnapshot: 5,
        priceAmountSnapshot: 10_000,
        packageNameSnapshot: pkg.name,
        refundedAt: new Date(),
      },
    });
    await approve(provider.id);
    await worker.runOnce();
    expect(await ctx.prisma.promotionEligibilityHold.findFirstOrThrow()).toMatchObject({
      signals: { signals: [{ code: 'PRIOR_PACKAGE_REFUND', refundedPurchases: 1, settledRequests: 0, paymentReversals: 0 }] },
    });
  });

  it('a missing proof is INELIGIBLE "not yet": no hold, no count, and the next raise after the proof grants', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { owner, provider } = await applicant({ phone: false });
    await approve(provider.id);
    await worker.runOnce();

    expect((await eventOf(provider.id)).status).toBe('EVALUATED');
    expect(await ctx.prisma.promotionEligibilityHold.count()).toBe(0);
    expect(await ctx.prisma.campaignEvaluationLog.findMany({ where: { campaignId: campaign.id } })).toMatchObject([
      { outcome: 'PROMOTION_INELIGIBLE', reasonCode: 'PHONE_UNVERIFIED' },
    ]);
    expect(await campaignCounters(campaign.id)).toMatchObject({ redemptionCount: 0, perProvider: 0, perDay: 0 });

    await ctx.prisma.user.update({ where: { id: owner.id }, data: { phoneVerifiedAt: new Date() } });
    await reRaise(provider.id);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: provider.id } })).toBe(1);
    expect(await ctx.prisma.campaignRegistrationCounter.count()).toBe(1);
  });

  it.each([
    [['EMAIL_VERIFIED', 'PHONE_VERIFIED', 'PROVIDER_APPROVED']],
    [['PROVIDER_APPROVED', 'PHONE_VERIFIED', 'EMAIL_VERIFIED']],
    [['PHONE_VERIFIED', 'PROVIDER_APPROVED', 'EMAIL_VERIFIED']],
  ] as const)('verification order %o: only the last fact makes the gate answer, and it answers REVIEW for NONE_DECLARED', async (order) => {
    await createCampaignFixture(ctx.prisma, {
      trigger: 'PROVIDER_ELIGIBILITY_REACHED',
      facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'],
    });
    const { owner, provider } = await applicant({ email: false, phone: false, registration: { type: 'NONE_DECLARED' } });
    for (const fact of order) {
      if (fact === 'PROVIDER_APPROVED') {
        await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
      } else {
        await ctx.prisma.user.update({
          where: { id: owner.id },
          data: fact === 'EMAIL_VERIFIED' ? { emailVerifiedAt: new Date() } : { phoneVerifiedAt: new Date() },
        });
      }
      await runSerializable(ctx.prisma, (tx) => engine.onProviderFact(tx, provider.id, fact), { label: 'test.fact' });
    }
    expect(await ctx.prisma.promotionEligibilityHold.count()).toBe(1);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.campaignRegistrationCounter.count()).toBe(0);
  });

  it('the payment trigger is not gated: an undeclared provider still gets a purchase bonus', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', credits: 5 });
    const { provider } = await applicant({ registration: 'unspecified', phone: false });
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: 5, priceAmount: 10_000 });
    const purchase = await ctx.prisma.packagePurchase.create({
      data: {
        providerId: provider.id,
        packageId: pkg.id,
        status: PackagePurchaseStatus.PAID,
        creditAmountSnapshot: 5,
        priceAmountSnapshot: 10_000,
        packageNameSnapshot: pkg.name,
        paidAt: new Date(),
      },
    });
    await runSerializable(
      ctx.prisma,
      (tx) => engine.evaluate(tx, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId: provider.id, purchaseId: purchase.id }),
      { label: 'test.evaluate' },
    );
    expect(await ctx.prisma.campaignRedemption.count()).toBe(1);
    expect(await ctx.prisma.promotionEligibilityHold.count()).toBe(0);
    expect(await ctx.prisma.campaignRegistrationCounter.count()).toBe(0);
  });
});

describe('a held event is never claimed', () => {
  it('whatever the clock says, and a re-raise leaves it held with one snapshot', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { provider } = await applicant({ registration: { type: 'NONE_DECLARED' } });
    await approve(provider.id);
    await worker.runOnce();
    const held = await eventOf(provider.id);
    await ctx.prisma.campaignTriggerEvent.update({ where: { id: held.id }, data: { nextAttemptAt: new Date(0) } });

    expect((await worker.runOnce({ now: new Date(Date.now() + 30 * 86_400_000) })).claimed).toBe(0);
    await reRaise(provider.id);
    expect((await worker.runOnce()).claimed).toBe(0);

    const after = await eventOf(provider.id);
    expect(after.status).toBe('HELD_FOR_REVIEW');
    expect(after.attemptCount).toBe(held.attemptCount);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(held.lastSeenAt.getTime());
    expect(await ctx.prisma.promotionEligibilityHold.count()).toBe(1);
  });

  it('the admin retry route does not take it either', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { provider } = await applicant({ registration: 'unspecified' });
    await approve(provider.id);
    await worker.runOnce();
    const event = await eventOf(provider.id);
    const response = await request(ctx.server)
      .post(`/admin/campaigns/${campaign.id}/evaluation-events/${event.id}/retry`)
      .set('Cookie', await rootCookie())
      .expect(409);
    expect(response.body.code).toBe('CAMPAIGN_EVENT_NOT_RETRYABLE');
  });
});

describe("a person's decision", () => {
  async function heldPair() {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', credits: 7 });
    const first = await applicant({ registration: { type: 'TAX_NUMBER', number: '1234567890' } });
    await approve(first.provider.id);
    await worker.runOnce();
    const second = await applicant({ registration: { type: 'TAX_NUMBER', number: '1234567890' } });
    await approve(second.provider.id);
    await worker.runOnce();
    return { campaign, first, second, event: await eventOf(second.provider.id) };
  }

  it('REVIEW → ELIGIBLE: back to PENDING once, the worker grants once, the counter moves for this provider', async () => {
    const { campaign, second, event } = await heldPair();
    const { admin, cookie } = await reviewer();

    const response = await decide(cookie, event.id, { decision: 'ELIGIBLE', reason: `  ${REASON}  ` }).expect(201);
    expect(response.body).toMatchObject({
      eventId: event.id,
      eventStatus: 'PENDING',
      review: { decision: 'ELIGIBLE', reason: REASON, decidedBy: { id: admin.id } },
      candidateCampaigns: [{ id: campaign.id }],
    });

    await worker.runOnce();
    expect((await eventOf(second.provider.id)).status).toBe('SETTLED');
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: second.provider.id } })).toBe(1);
    expect(await ctx.prisma.campaignRegistrationCounter.count({ where: { providerId: second.provider.id } })).toBe(1);
    // The gate was not asked again: no second snapshot.
    expect(await ctx.prisma.promotionEligibilityHold.count()).toBe(1);

    // A second decision, and the grant after a re-raise, are both refused.
    expect((await decide(cookie, event.id, { decision: 'INELIGIBLE', reason: REASON }).expect(409)).body.code).toBe(
      'ELIGIBILITY_DECISION_ALREADY_RECORDED',
    );
    await reRaise(second.provider.id);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: second.provider.id } })).toBe(1);
    expect(await ctx.prisma.campaignRegistrationCounter.findFirstOrThrow({ where: { providerId: second.provider.id } })).toMatchObject({
      redemptionCount: 1,
    });
  });

  it('REVIEW → INELIGIBLE: EVALUATED with the decision logged, no grant — and a later raise does not undo it', async () => {
    const { campaign, second, event } = await heldPair();
    const { cookie } = await reviewer();
    const before = await campaignCounters(campaign.id);

    await decide(cookie, event.id, { decision: 'INELIGIBLE', reason: REASON }).expect(201);
    expect((await eventOf(second.provider.id)).status).toBe('EVALUATED');
    expect((await worker.runOnce()).claimed).toBe(0);

    await reRaise(second.provider.id);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: second.provider.id } })).toBe(0);
    expect(await campaignCounters(campaign.id)).toEqual(before);
    expect(await ctx.prisma.promotionEligibilityHold.count()).toBe(1);
    const logs = await ctx.prisma.campaignEvaluationLog.findMany({
      where: { triggerEventId: event.id, outcome: 'PROMOTION_INELIGIBLE' },
      orderBy: { evaluatedAt: 'asc' },
    });
    expect(logs.map((row) => [row.campaignId, row.reasonCode])).toEqual([
      [null, 'HUMAN_DECISION'],
      [campaign.id, 'HUMAN_DECISION'],
    ]);
  });

  it('the reason is required, bounded and trimmed; the decision is a closed pair; an unknown event is 404', async () => {
    const { event } = await heldPair();
    const { cookie } = await reviewer();
    await decide(cookie, event.id, { decision: 'ELIGIBLE' }).expect(400);
    await decide(cookie, event.id, { decision: 'ELIGIBLE', reason: '   kısa    ' }).expect(400);
    await decide(cookie, event.id, { decision: 'ELIGIBLE', reason: 'x'.repeat(1001) }).expect(400);
    await decide(cookie, event.id, { decision: 'MAYBE', reason: REASON }).expect(400);
    expect((await decide(cookie, 'nope', { decision: 'ELIGIBLE', reason: REASON }).expect(404)).body.code).toBe(
      'ELIGIBILITY_HOLD_NOT_FOUND',
    );
    expect(await ctx.prisma.promotionEligibilityReview.count()).toBe(0);
    expect((await eventOf((await ctx.prisma.promotionEligibilityHold.findFirstOrThrow()).providerId)).status).toBe('HELD_FOR_REVIEW');
  });

  it('two concurrent decisions: exactly one is recorded, the other is a 409', async () => {
    const { event } = await heldPair();
    const one = await reviewer();
    const two = await reviewer();
    const responses = await Promise.all([
      decide(one.cookie, event.id, { decision: 'ELIGIBLE', reason: REASON }),
      decide(two.cookie, event.id, { decision: 'INELIGIBLE', reason: REASON }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.promotionEligibilityReview.count()).toBe(1);
  });

  it('a decision followed by four concurrent worker passes produces one grant, one lot and one count', async () => {
    const { second, event } = await heldPair();
    const { cookie } = await reviewer();
    await decide(cookie, event.id, { decision: 'ELIGIBLE', reason: REASON }).expect(201);
    const passes = await Promise.all(Array.from({ length: 4 }, () => worker.runOnce()));
    expect(passes.reduce((sum, pass) => sum + pass.claimed, 0)).toBe(1);
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: second.provider.id } })).toBe(1);
    expect(await ctx.prisma.promoCreditLot.count({ where: { providerId: second.provider.id } })).toBe(1);
    expect(await ctx.prisma.campaignRegistrationCounter.count({ where: { providerId: second.provider.id } })).toBe(1);
  });

  it('may be recorded while the engine is off; nothing is granted until it is on', async () => {
    const { second, event } = await heldPair();
    const { cookie } = await reviewer();
    await setEngineEnabled(ctx.prisma, false);
    await decide(cookie, event.id, { decision: 'ELIGIBLE', reason: REASON }).expect(201);
    expect((await worker.runOnce()).skipped).toBe('ENGINE_DISABLED');
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: second.provider.id } })).toBe(0);
    await setEngineEnabled(ctx.prisma, true);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: second.provider.id } })).toBe(1);
  });

  it('the hold and the review are append-only, and a review must name the hold of its own event', async () => {
    const { event, first } = await heldPair();
    const { admin, cookie } = await reviewer();
    await decide(cookie, event.id, { decision: 'INELIGIBLE', reason: REASON }).expect(201);
    await expect(ctx.prisma.promotionEligibilityHold.updateMany({ data: { snapshotVersion: 2 } })).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.promotionEligibilityReview.deleteMany()).rejects.toThrow(/append-only/);

    const hold = await ctx.prisma.promotionEligibilityHold.findFirstOrThrow();
    const other = await ctx.prisma.campaignTriggerEvent.create({
      data: { triggerEventKey: `PROVIDER_APPROVED:other-${uniqueSuffix()}`, trigger: 'PROVIDER_APPROVED', providerId: first.provider.id },
    });
    await expect(
      ctx.prisma.promotionEligibilityReview.create({
        data: { triggerEventId: other.id, holdId: hold.id, providerId: hold.providerId, decision: 'ELIGIBLE', reason: REASON, decidedById: admin.id },
      }),
    ).rejects.toThrow();
  });
});

describe('the counter moves only with a real grant', () => {
  it('a candidate refused by its limit leaves no count behind', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED', credits: 10, budgetCredits: 15 });
    await ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { budgetConsumedCredits: 10 } });
    const { provider } = await applicant();
    await approve(provider.id);
    await worker.runOnce();
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.campaignRegistrationCounter.count()).toBe(0);
    expect(await ctx.prisma.campaignEvaluationLog.count({ where: { outcome: 'BUDGET_EXHAUSTED' } })).toBe(1);
  });

  it('an engine fault rolls the grant and the count back together', async () => {
    const { version } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { provider } = await applicant();
    const repository = ctx.app.get((await import('../src/modules/campaigns/engine/campaign-engine.repository')).CampaignEngineRepository);
    const original = repository.countRegistrationGrant.bind(repository);
    repository.countRegistrationGrant = async () => {
      throw new TypeError('simulated fault after the grant');
    };
    try {
      await approve(provider.id);
      await worker.runOnce();
    } finally {
      repository.countRegistrationGrant = original;
    }
    expect((await eventOf(provider.id)).status).toBe('RETRY_WAIT');
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(0);
    expect(await ctx.prisma.campaignRegistrationCounter.count()).toBe(0);
    expect(await ctx.prisma.campaign.findFirstOrThrow({ where: { activeVersionId: version.id } })).toMatchObject({ redemptionCount: 0 });
  });
});

describe('the queue routes', () => {
  it('need PROMOTION_ELIGIBILITY_REVIEW; CAMPAIGNS_READ is not enough; SUPER_ADMIN passes', async () => {
    await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { provider } = await applicant({ registration: { type: 'NONE_DECLARED' } });
    await approve(provider.id);
    await worker.runOnce();
    const event = await eventOf(provider.id);

    const { admin: reader } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CAMPAIGNS_READ]);
    const readerCookie = await loginAs(ctx.prisma, reader.id);
    const ownerCookie = await loginAs(ctx.prisma, provider.userId!);
    for (const cookie of [readerCookie, ownerCookie]) {
      await request(ctx.server).get('/admin/promotion-eligibility/holds').set('Cookie', cookie).expect(403);
      await request(ctx.server).get(`/admin/promotion-eligibility/holds/${event.id}`).set('Cookie', cookie).expect(403);
      await decide(cookie, event.id, { decision: 'ELIGIBLE', reason: REASON }).expect(403);
    }
    await request(ctx.server).get('/admin/promotion-eligibility/holds').expect(401);
    expect(await ctx.prisma.promotionEligibilityReview.count()).toBe(0);

    const { cookie } = await reviewer();
    const open = await request(ctx.server).get('/admin/promotion-eligibility/holds').set('Cookie', cookie).expect(200);
    expect(open.body.items).toMatchObject([{ eventId: event.id, provider: { id: provider.id }, review: null }]);
    await decide(await rootCookie(), event.id, { decision: 'INELIGIBLE', reason: REASON }).expect(201);
    expect((await request(ctx.server).get('/admin/promotion-eligibility/holds').set('Cookie', cookie).expect(200)).body.items).toEqual([]);
    const decided = await request(ctx.server).get('/admin/promotion-eligibility/holds?filter=decided').set('Cookie', cookie).expect(200);
    expect(decided.body.items).toMatchObject([{ eventId: event.id, review: { decision: 'INELIGIBLE' } }]);
  });

  it('the campaign queue counts held events', async () => {
    const { campaign } = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const { provider } = await applicant({ registration: 'unspecified' });
    await approve(provider.id);
    await worker.runOnce();
    const detail = await request(ctx.server).get(`/admin/campaigns/${campaign.id}`).set('Cookie', await rootCookie()).expect(200);
    expect(detail.body.evaluationQueue).toMatchObject({ heldForReview: 1, pending: 0 });
  });
});
