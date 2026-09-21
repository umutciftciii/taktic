import { CampaignAuditAction, CampaignStatus, CampaignTriggerEventStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { createCampaignFixture, createPromoLotFixture, engineWriteSnapshot, setEngineEnabled, walletInvariant } from './campaign-fixtures';
import { createOfferPackage, createProviderProfile, createTestApp, createUser, currentCreditBalance, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * CMP-003 S3 — the operator's side of revocation and the evaluation queue,
 * SUPER_ADMIN only.
 *
 * Revoke: one redemption, named by id under its campaign, with a reason of
 * 3–500 characters; the same `CampaignRevokeService` path the payment
 * reversal takes, so the ledger row, the lot, the redemption and the daily
 * counter come out identical — plus a REDEMPTION_REVOKED audit row with the
 * reason. Anything but a GRANTED redemption is refused with nothing written.
 *
 * Retry: an event parked RETRY_WAIT, or PROCESSING under a lease that has
 * lapsed, goes back to the front of the worker's queue; nothing is
 * evaluated or granted by the request itself, and a SETTLED, EVALUATED,
 * PENDING or live-leased event is refused untouched.
 *
 * Reads: the campaign's redemptions and the events its running rule is a
 * candidate for, paginated, carrying ids, statuses, amounts, closed codes
 * and the provider's business name — never an e-mail, a phone number, a
 * token or a payment payload.
 */

let ctx: TestContext;
let worker: CampaignEvaluationWorker;

beforeAll(async () => {
  ctx = await createTestApp();
  worker = ctx.app.get(CampaignEvaluationWorker);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

async function adminCookie(name = 'Yönetici') {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function providerFixture() {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
  return { owner, provider };
}

const revoke = (cookie: string, campaignId: string, redemptionId: string, body: Record<string, unknown> = { reason: 'Sahte ödeme şüphesi' }) =>
  request(ctx.server).post(`/admin/campaigns/${campaignId}/redemptions/${redemptionId}/revoke`).set('Cookie', cookie).send(body);
const retry = (cookie: string, campaignId: string, eventId: string) =>
  request(ctx.server).post(`/admin/campaigns/${campaignId}/evaluation-events/${eventId}/retry`).set('Cookie', cookie).send({});
const redemptions = (cookie: string, campaignId: string, query = '') =>
  request(ctx.server).get(`/admin/campaigns/${campaignId}/redemptions${query}`).set('Cookie', cookie);
const events = (cookie: string, campaignId: string, query = '') =>
  request(ctx.server).get(`/admin/campaigns/${campaignId}/evaluation-events${query}`).set('Cookie', cookie);

function ledger(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({
    where: { providerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, type: true, amount: true, balanceAfter: true, reason: true, referenceType: true, referenceId: true, createdById: true },
  });
}

/** A PAID offer-package purchase and its payment event, written straight to the tables in the given state. */
async function paymentEvent(campaign: { version: { id: string } }, providerId: string, status: CampaignTriggerEventStatus, extra: Record<string, unknown> = {}) {
  const creditPackage = await createOfferPackage(ctx.prisma, { creditAmount: 25 });
  const purchase = await ctx.prisma.packagePurchase.create({
    data: {
      providerId,
      packageId: creditPackage.id,
      kind: 'OFFER_PACKAGE',
      status: 'PAID',
      priceAmountSnapshot: 49900,
      currencySnapshot: 'TRY',
      creditAmountSnapshot: 25,
      packageNameSnapshot: creditPackage.name,
      paymentProvider: 'mock',
    },
  });
  return ctx.prisma.campaignTriggerEvent.create({
    data: {
      triggerEventKey: `PACKAGE_PAYMENT_SUCCEEDED:${purchase.id}`,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      providerId,
      purchaseId: purchase.id,
      status,
      ...extra,
    },
  });
}

describe('access', () => {
  it('refuses anonymous, CUSTOMER and PROVIDER sessions on every operations route, writing nothing', async () => {
    const { provider } = await providerFixture();
    const lot = await createPromoLotFixture(ctx.prisma, provider.id);
    const event = await ctx.prisma.campaignTriggerEvent.update({ where: { id: lot.event.id }, data: { status: 'RETRY_WAIT' } });
    const before = await engineWriteSnapshot(ctx.prisma);
    const customer = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.CUSTOMER })).id);
    const providerCookie = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.PROVIDER })).id);

    const calls = (cookie: string) => [
      () => revoke(cookie, lot.campaign.id, lot.redemption.id),
      () => retry(cookie, lot.campaign.id, event.id),
      () => redemptions(cookie, lot.campaign.id),
      () => events(cookie, lot.campaign.id),
    ];
    for (const call of calls('')) {
      expect((await call()).status).toBe(401);
    }
    for (const cookie of [customer, providerCookie]) {
      for (const call of calls(cookie)) {
        expect((await call()).status).toBe(403);
      }
    }
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
    expect((await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: lot.redemption.id } })).status).toBe('GRANTED');
  });
});

describe('admin revoke', () => {
  it('refuses a missing, too short or too long reason and a redemption of another campaign, writing nothing', async () => {
    const { cookie } = await adminCookie();
    const { provider } = await providerFixture();
    const lot = await createPromoLotFixture(ctx.prisma, provider.id);
    const other = await createCampaignFixture(ctx.prisma);
    const before = await engineWriteSnapshot(ctx.prisma);

    await revoke(cookie, lot.campaign.id, lot.redemption.id, {}).expect(400);
    await revoke(cookie, lot.campaign.id, lot.redemption.id, { reason: 'ab' }).expect(400);
    await revoke(cookie, lot.campaign.id, lot.redemption.id, { reason: 'x'.repeat(501) }).expect(400);
    const wrongCampaign = await revoke(cookie, other.campaign.id, lot.redemption.id).expect(404);
    expect(wrongCampaign.body.code).toBe('CAMPAIGN_REDEMPTION_NOT_FOUND');
    const unknown = await revoke(cookie, lot.campaign.id, 'does-not-exist').expect(404);
    expect(unknown.body.code).toBe('CAMPAIGN_REDEMPTION_NOT_FOUND');

    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(before);
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: lot.campaign.id } })).toBe(0);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);
  });

  it('revokes a granted redemption exactly as a payment reversal would, with a REDEMPTION_REVOKED audit row carrying the reason', async () => {
    const { admin, cookie } = await adminCookie('Denetçi');
    const { provider } = await providerFixture();
    const lot = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 10 });
    await setEngineEnabled(ctx.prisma, false);

    const response = await revoke(cookie, lot.campaign.id, lot.redemption.id, { reason: '  Sahte ödeme şüphesi  ' }).expect(201);
    expect(response.body.campaign.id).toBe(lot.campaign.id);

    const rows = await ledger(provider.id);
    expect(rows.map((row) => [row.type, row.amount, row.balanceAfter])).toEqual([
      ['CAMPAIGN_GRANT', 10, 10],
      ['CAMPAIGN_REVOKE', -10, 0],
    ]);
    expect(rows[1]).toMatchObject({ reason: 'PROMO_LOT_REVOKED:ADMIN_REVOKED', referenceType: 'PromoCreditLot', referenceId: lot.lot.id, createdById: admin.id });
    expect(await ctx.prisma.promoCreditLot.findUniqueOrThrow({ where: { id: lot.lot.id } })).toMatchObject({ status: 'REVOKED', remainingCredits: 0, revokeTransactionId: rows[1]!.id });
    const redemption = await ctx.prisma.campaignRedemption.findUniqueOrThrow({ where: { id: lot.redemption.id } });
    expect(redemption).toMatchObject({
      status: 'REVOKED',
      revokeReason: 'ADMIN_REVOKED',
      spentAtRevoke: 0,
      revokedById: admin.id,
      revokeNote: 'Sahte ödeme şüphesi',
      revokedByWebhookEventId: null,
    });
    const audit = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId: lot.campaign.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: CampaignAuditAction.REDEMPTION_REVOKED,
      actorId: admin.id,
      campaignVersionId: lot.version.id,
      summary: { redemptionId: lot.redemption.id, revokedCredits: 10, spentAtRevoke: 0, reason: 'Sahte ödeme şüphesi', versionNumber: 1 },
    });
    const counters = await ctx.prisma.campaignRevokeDailyCounter.findMany({ where: { campaignId: lot.campaign.id } });
    expect(counters.map((row) => row.revokeCount)).toEqual([1]);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
    const state = await walletInvariant(ctx.prisma, provider.id);
    expect(state.sumOfAmounts).toBe(state.balance);
    // The audit and the redemption carry the reason and nothing about the provider.
    expect(JSON.stringify(audit)).not.toContain(provider.email);
    expect(JSON.stringify(audit)).not.toContain(provider.phone);
  });

  it('refuses a second revoke of the same redemption and a revoke of an expired one, writing nothing', async () => {
    const { cookie } = await adminCookie();
    const { provider } = await providerFixture();
    const lot = await createPromoLotFixture(ctx.prisma, provider.id);
    await revoke(cookie, lot.campaign.id, lot.redemption.id).expect(201);
    const before = await engineWriteSnapshot(ctx.prisma);
    const auditBefore = await ctx.prisma.campaignAuditLog.count();

    const again = await revoke(cookie, lot.campaign.id, lot.redemption.id).expect(409);
    expect(again.body.code).toBe('CAMPAIGN_REDEMPTION_NOT_REVOCABLE');

    const expired = await createPromoLotFixture(ctx.prisma, provider.id);
    await ctx.prisma.promoCreditLot.update({ where: { id: expired.lot.id }, data: { status: 'EXPIRED', remainingCredits: 0 } });
    await ctx.prisma.campaignRedemption.update({ where: { id: expired.redemption.id }, data: { status: 'EXPIRED' } });
    const snapshot = await engineWriteSnapshot(ctx.prisma);
    const refused = await revoke(cookie, expired.campaign.id, expired.redemption.id).expect(409);
    expect(refused.body.code).toBe('CAMPAIGN_REDEMPTION_NOT_REVOCABLE');

    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(snapshot);
    expect(before.ledgerRows).toBe((await engineWriteSnapshot(ctx.prisma)).ledgerRows - 1); // only the expired fixture's grant row was added
    expect(await ctx.prisma.campaignAuditLog.count()).toBe(auditBefore);
    expect((await ctx.prisma.campaignRevokeDailyCounter.findFirstOrThrow({ where: { campaignId: lot.campaign.id } })).revokeCount).toBe(1);
  });

  it('pauses the campaign with the operator as actor once the running version’s daily threshold is exceeded', async () => {
    const { admin, cookie } = await adminCookie();
    const shared = await createCampaignFixture(ctx.prisma, { maxRedemptionsPerProvider: 5 });
    await ctx.prisma.campaignVersion.update({ where: { id: shared.version.id }, data: { maxRevokesPerDay: 1 } });
    const first = await createPromoLotFixture(ctx.prisma, (await providerFixture()).provider.id, { campaign: shared });
    const second = await createPromoLotFixture(ctx.prisma, (await providerFixture()).provider.id, { campaign: shared });

    await revoke(cookie, shared.campaign.id, first.redemption.id).expect(201);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: shared.campaign.id } })).status).toBe(CampaignStatus.ACTIVE);
    const paused = await revoke(cookie, shared.campaign.id, second.redemption.id).expect(201);
    expect(paused.body.campaign.status).toBe('PAUSED');
    const autoPause = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId: shared.campaign.id, action: CampaignAuditAction.AUTO_PAUSED } });
    expect(autoPause).toHaveLength(1);
    expect(autoPause[0]).toMatchObject({ actorId: admin.id, summary: { actorKind: 'ADMIN', source: 'ADMIN_REVOKED', revokeCount: 2, maxRevokesPerDay: 1 } });
    // Newest first; the pause and the revoke that caused it share a commit, so only the multiset is fixed.
    expect([...paused.body.audit.map((entry: { action: string }) => entry.action)].sort()).toEqual(['AUTO_PAUSED', 'REDEMPTION_REVOKED', 'REDEMPTION_REVOKED']);
  });
});

describe('reading redemptions and the campaign’s event queue', () => {
  it('lists redemptions newest first with grant and revoke summaries, the provider’s business name and no contact detail', async () => {
    const { admin, cookie } = await adminCookie('Denetçi');
    const shared = await createCampaignFixture(ctx.prisma, { maxRedemptionsPerProvider: 5 });
    const a = await providerFixture();
    const b = await providerFixture();
    const granted = await createPromoLotFixture(ctx.prisma, a.provider.id, { campaign: shared });
    const revoked = await createPromoLotFixture(ctx.prisma, b.provider.id, { campaign: shared });
    await revoke(cookie, shared.campaign.id, revoked.redemption.id, { reason: 'Gerekçe metni' }).expect(201);

    const page = await redemptions(cookie, shared.campaign.id, '?limit=1').expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBe(revoked.redemption.id);
    expect(page.body.items[0]).toMatchObject({
      id: revoked.redemption.id,
      status: 'REVOKED',
      versionNumber: 1,
      trigger: 'PROVIDER_APPROVED',
      provider: { id: b.provider.id, businessName: b.provider.businessName },
      grantedCredits: 10,
      lot: { id: revoked.lot.id, status: 'REVOKED', remainingCredits: 0 },
      revokeReason: 'ADMIN_REVOKED',
      spentAtRevoke: 0,
      revokedCredits: 10,
      revokedBy: { id: admin.id, name: 'Denetçi' },
      revokeNote: 'Gerekçe metni',
      revokedByWebhookEventId: null,
    });

    const rest = await redemptions(cookie, shared.campaign.id, `?limit=1&cursor=${page.body.nextCursor}`).expect(200);
    expect(rest.body.items[0]).toMatchObject({
      id: granted.redemption.id,
      status: 'GRANTED',
      provider: { id: a.provider.id },
      lot: { status: 'ACTIVE', remainingCredits: 10 },
      revokedAt: null,
      revokedBy: null,
      revokeNote: null,
    });
    expect(rest.body.nextCursor).toBeNull();

    const serialised = JSON.stringify([page.body, rest.body]);
    for (const forbidden of [a.provider.email, a.provider.phone, b.provider.email, b.provider.phone, a.owner.email, b.owner.email]) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(serialised).not.toContain('rulesSnapshot');
  });

  it('lists the events the running rule is a candidate for, with the last outcome for this campaign and whether a retry is possible', async () => {
    const { cookie } = await adminCookie();
    const { provider } = await providerFixture();
    const campaign = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED' });
    const otherTrigger = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const now = new Date();
    const parked = await paymentEvent(campaign, provider.id, 'RETRY_WAIT', { lastErrorCode: 'ENGINE_ERROR', lastErrorAt: now, attemptCount: 2 });
    await ctx.prisma.campaignEvaluationLog.create({
      data: { triggerEventId: parked.id, providerId: provider.id, campaignId: campaign.campaign.id, campaignVersionId: campaign.version.id, outcome: 'ENGINE_ERROR', reasonCode: 'ENGINE_ERROR' },
    });
    const pending = await paymentEvent(campaign, provider.id, 'PENDING');
    const live = await paymentEvent(campaign, provider.id, 'PROCESSING', { leaseUntil: new Date(now.getTime() + 60_000) });
    const lapsed = await paymentEvent(campaign, provider.id, 'PROCESSING', { leaseUntil: new Date(now.getTime() - 60_000) });
    await ctx.prisma.campaignTriggerEvent.create({ data: { triggerEventKey: `PROVIDER_APPROVED:${provider.id}`, trigger: 'PROVIDER_APPROVED', providerId: provider.id } });

    const page = await events(cookie, campaign.campaign.id).expect(200);
    const byId = new Map<string, Record<string, unknown>>(page.body.items.map((item: { id: string }) => [item.id, item]));
    expect(page.body.items).toHaveLength(4);
    expect(byId.get(parked.id)).toMatchObject({
      status: 'RETRY_WAIT',
      attemptCount: 2,
      lastErrorCode: 'ENGINE_ERROR',
      retryable: true,
      lastOutcome: { outcome: 'ENGINE_ERROR', reasonCode: 'ENGINE_ERROR' },
    });
    expect(byId.get(pending.id)).toMatchObject({ status: 'PENDING', retryable: false, lastOutcome: null });
    expect(byId.get(live.id)).toMatchObject({ status: 'PROCESSING', retryable: false });
    expect(byId.get(lapsed.id)).toMatchObject({ status: 'PROCESSING', retryable: true });

    const other = await events(cookie, otherTrigger.campaign.id).expect(200);
    expect(other.body.items.map((item: { triggerEventKey: string }) => item.triggerEventKey)).toEqual([`PROVIDER_APPROVED:${provider.id}`]);
    expect(JSON.stringify(page.body)).not.toContain(provider.email);
  });
});

describe('manual retry', () => {
  it('puts a parked event back at the front of the queue with an audit row, and the worker — not the request — evaluates it', async () => {
    const { admin, cookie } = await adminCookie();
    await setEngineEnabled(ctx.prisma, true);
    const { provider } = await providerFixture();
    const campaign = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', maxRedemptionsPerProvider: 5 });
    const later = new Date(Date.now() + 6 * 3_600_000);
    const parked = await paymentEvent(campaign, provider.id, 'RETRY_WAIT', { lastErrorCode: 'WORKER_ERROR', lastErrorAt: new Date(), attemptCount: 3, nextAttemptAt: later });
    const before = await engineWriteSnapshot(ctx.prisma);

    const response = await retry(cookie, campaign.campaign.id, parked.id).expect(201);
    expect(response.body).toMatchObject({ id: parked.id, status: 'RETRY_WAIT', retryable: true });

    const event = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { id: parked.id } });
    expect(event.status).toBe('RETRY_WAIT');
    expect(event.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(event.leaseUntil).toBeNull();
    expect(event.attemptCount).toBe(3);
    expect(event.lastErrorCode).toBe('WORKER_ERROR');
    const after = await engineWriteSnapshot(ctx.prisma);
    expect({ ...after, triggerEvents: before.triggerEvents }).toEqual(before); // no grant, no log, no lot, no ledger row from the request
    const audit = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId: campaign.campaign.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: CampaignAuditAction.EVENT_RETRY_REQUESTED,
      actorId: admin.id,
      summary: { triggerEventId: parked.id, triggerEventKey: parked.triggerEventKey, previousStatus: 'RETRY_WAIT', attemptCount: 3 },
    });

    const run = await worker.runOnce();
    expect(run.outcomes).toEqual([{ triggerEventKey: parked.triggerEventKey, outcome: 'SETTLED' }]);
    expect(await ctx.prisma.campaignRedemption.count({ where: { triggerEventId: parked.id, status: 'GRANTED' } })).toBe(1);
  });

  it('releases a lapsed lease, and refuses a settled, evaluated, pending or live-leased event untouched', async () => {
    const { cookie } = await adminCookie();
    await setEngineEnabled(ctx.prisma, true);
    const { provider } = await providerFixture();
    const campaign = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED', maxRedemptionsPerProvider: 5 });
    const now = new Date();
    const lapsed = await paymentEvent(campaign, provider.id, 'PROCESSING', { leaseUntil: new Date(now.getTime() - 1), nextAttemptAt: new Date(now.getTime() + 3_600_000) });
    const live = await paymentEvent(campaign, provider.id, 'PROCESSING', { leaseUntil: new Date(now.getTime() + 300_000) });
    const pending = await paymentEvent(campaign, provider.id, 'PENDING');
    const evaluated = await paymentEvent(campaign, provider.id, 'EVALUATED');
    const settledLot = await createPromoLotFixture(ctx.prisma, provider.id, { campaign });

    await retry(cookie, campaign.campaign.id, lapsed.id).expect(201);
    const released = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { id: lapsed.id } });
    expect(released.status).toBe('RETRY_WAIT');
    expect(released.leaseUntil).toBeNull();
    expect(released.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

    const untouched = await ctx.prisma.campaignTriggerEvent.findMany({ where: { id: { in: [live.id, pending.id, evaluated.id, settledLot.event.id] } }, orderBy: { id: 'asc' } });
    for (const event of [live, pending, evaluated]) {
      const refused = await retry(cookie, campaign.campaign.id, event.id).expect(409);
      expect(refused.body.code).toBe('CAMPAIGN_EVENT_NOT_RETRYABLE');
    }
    // The settled fixture's event answers another trigger, so it is not this campaign's to retry.
    await retry(cookie, campaign.campaign.id, settledLot.event.id).expect(404);
    await ctx.prisma.campaignTriggerEvent.update({
      where: { id: settledLot.event.id },
      data: { status: 'SETTLED', settledByCampaignId: campaign.campaign.id, settledRedemptionId: settledLot.redemption.id, settledAt: now, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', purchaseId: (await ctx.prisma.packagePurchase.findFirstOrThrow()).id },
    });
    const settledRefusal = await retry(cookie, campaign.campaign.id, settledLot.event.id).expect(409);
    expect(settledRefusal.body.code).toBe('CAMPAIGN_EVENT_NOT_RETRYABLE');
    expect(await ctx.prisma.campaignTriggerEvent.findMany({ where: { id: { in: [live.id, pending.id, evaluated.id] } }, orderBy: { id: 'asc' } })).toEqual(
      untouched.filter((event) => event.id !== settledLot.event.id),
    );
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.campaign.id, action: CampaignAuditAction.EVENT_RETRY_REQUESTED } })).toBe(1);
  });

  it('is refused while the engine is off, and 404s an event of another trigger or campaign, writing nothing', async () => {
    const { cookie } = await adminCookie();
    await setEngineEnabled(ctx.prisma, false);
    const { provider } = await providerFixture();
    const campaign = await createCampaignFixture(ctx.prisma, { trigger: 'PACKAGE_PAYMENT_SUCCEEDED' });
    const parked = await paymentEvent(campaign, provider.id, 'RETRY_WAIT', { nextAttemptAt: new Date(Date.now() + 3_600_000) });
    const before = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { id: parked.id } });

    const off = await retry(cookie, campaign.campaign.id, parked.id).expect(409);
    expect(off.body.code).toBe('CAMPAIGN_ENGINE_DISABLED');
    await setEngineEnabled(ctx.prisma, true);
    const other = await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
    const wrong = await retry(cookie, other.campaign.id, parked.id).expect(404);
    expect(wrong.body.code).toBe('CAMPAIGN_EVENT_NOT_FOUND');
    await retry(cookie, campaign.campaign.id, 'nope').expect(404);

    expect(await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { id: parked.id } })).toEqual(before);
    expect(await ctx.prisma.campaignAuditLog.count()).toBe(0);
  });
});
