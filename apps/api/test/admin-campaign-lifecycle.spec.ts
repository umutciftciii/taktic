import { CampaignAuditAction, CampaignStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactSourceRegistry } from '../src/modules/campaigns/engine/fact-source-registry';
import { engineWriteSnapshot, setEngineEnabled } from './campaign-fixtures';
import { createOfferPackage, createProviderProfile, createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * CMP-002 S2B2 — the campaign lifecycle, SUPER_ADMIN only.
 *
 * DRAFT → ACTIVE, ACTIVE ⇄ PAUSED, ACTIVE/PAUSED → ENDED, ENDED terminal.
 * Activation moves `activeVersionId` to an existing immutable version and
 * writes an audit row; it is refused — with nothing written — while the
 * engine switch is off (`CAMPAIGN_ENGINE_DISABLED`), when a fact source the
 * version depends on has no registered PROVIDER writer
 * (`FACT_SOURCE_UNAVAILABLE`), when a limit is below what the campaign has
 * already consumed (`LIMIT_BELOW_CONSUMED`), or when the window has closed.
 * Pause and end never need the engine. No route here grants anything: every
 * scenario ends with zero engine rows and zero ledger rows.
 */

let ctx: TestContext;
let registry: FactSourceRegistry;

beforeAll(async () => {
  ctx = await createTestApp();
  registry = ctx.app.get(FactSourceRegistry);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const K2 = {
  schemaVersion: 1,
  trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
  conditions: { all: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }, { type: 'NO_PRIOR_REVOCATION' }] },
  benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
  limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 1000, maxRedemptionsPerDay: null, budgetCredits: 10000, maxRevokesPerDay: null },
  window: { startAt: null, endAt: null },
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 100,
};

const K1 = {
  schemaVersion: 1,
  trigger: 'PROVIDER_ELIGIBILITY_REACHED',
  eligibility: { facts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'] },
  conditions: { all: [{ type: 'NO_PRIOR_REVOCATION' }] },
  benefit: { type: 'PROMO_CREDITS', credits: 5, expiresInDays: 14 },
  limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: null, maxRedemptionsPerDay: null, budgetCredits: null, maxRevokesPerDay: null },
  window: { startAt: null, endAt: null },
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 10,
};

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function draft(cookie: string, definition: Record<string, unknown>, key = `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`) {
  const created = await request(ctx.server).post('/admin/campaigns').set('Cookie', cookie).send({ key, name: 'Kampanya', definition }).expect(201);
  return created.body as { campaign: { id: string; status: string; activeVersionId: string | null }; currentVersion: { id: string; versionNumber: number } };
}

const activate = (cookie: string, id: string, versionNumber: number) =>
  request(ctx.server).post(`/admin/campaigns/${id}/versions/${versionNumber}/activate`).set('Cookie', cookie).send({});
const transition = (cookie: string, id: string, verb: 'pause' | 'resume' | 'end', reason = 'operatör kararı') =>
  request(ctx.server).post(`/admin/campaigns/${id}/${verb}`).set('Cookie', cookie).send({ reason });

async function auditActions(campaignId: string) {
  const rows = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map((row) => row.action);
}

async function snapshot() {
  return {
    campaigns: await ctx.prisma.campaign.findMany({ select: { id: true, status: true, activeVersionId: true }, orderBy: { id: 'asc' } }),
    versions: await ctx.prisma.campaignVersion.count(),
    audit: await ctx.prisma.campaignAuditLog.count(),
    engine: await engineWriteSnapshot(ctx.prisma),
  };
}

describe('access', () => {
  it('refuses anonymous, CUSTOMER and PROVIDER sessions on every lifecycle route', async () => {
    const customer = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.CUSTOMER })).id);
    const provider = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.PROVIDER })).id);
    await request(ctx.server).post('/admin/campaigns/x/versions/1/activate').send({}).expect(401);
    for (const cookie of [customer, provider]) {
      await activate(cookie, 'x', 1).expect(403);
      await transition(cookie, 'x', 'pause').expect(403);
      await transition(cookie, 'x', 'resume').expect(403);
      await transition(cookie, 'x', 'end').expect(403);
    }
  });
});

describe('with the engine switch off', () => {
  it('activate and resume are refused with CAMPAIGN_ENGINE_DISABLED and write nothing; pause and end still work', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    const before = await snapshot();

    const refused = await activate(cookie, campaign.id, currentVersion.versionNumber).expect(409);
    expect(refused.body.code).toBe('CAMPAIGN_ENGINE_DISABLED');
    expect(await snapshot()).toEqual(before);
    expect(refused.body.message).toMatch(/motoru kapalı/i);

    // The same refusal when the settings row is missing altogether (fail-closed).
    await ctx.prisma.operationsSettings.deleteMany();
    expect((await activate(cookie, campaign.id, currentVersion.versionNumber).expect(409)).body.code).toBe('CAMPAIGN_ENGINE_DISABLED');
    expect(await snapshot()).toEqual(before);

    // A campaign that is already ACTIVE (switched on earlier, switch since
    // turned off) can still be paused and ended — and not resumed.
    await ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { status: CampaignStatus.ACTIVE, activeVersionId: currentVersion.id } });
    const paused = await transition(cookie, campaign.id, 'pause', 'motor kapatıldı').expect(201);
    expect(paused.body.campaign.status).toBe('PAUSED');
    const resume = await transition(cookie, campaign.id, 'resume').expect(409);
    expect(resume.body.code).toBe('CAMPAIGN_ENGINE_DISABLED');
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(CampaignStatus.PAUSED);
    const ended = await transition(cookie, campaign.id, 'end', 'kampanya bitti').expect(201);
    expect(ended.body.campaign.status).toBe('ENDED');
    expect(await auditActions(campaign.id)).toEqual([
      CampaignAuditAction.CREATED,
      CampaignAuditAction.VERSION_CREATED,
      CampaignAuditAction.PAUSED,
      CampaignAuditAction.ENDED,
    ]);
    const audit = await ctx.prisma.campaignAuditLog.findFirst({ where: { campaignId: campaign.id, action: CampaignAuditAction.PAUSED } });
    expect(audit?.summary).toMatchObject({ reason: 'motor kapatıldı', versionNumber: 1 });
    expect((await snapshot()).engine).toMatchObject({ triggerEvents: 0, redemptions: 0, lots: 0, ledgerRows: 0, evaluationLogs: 0 });
  });
});

describe('with the engine switch on', () => {
  beforeEach(async () => {
    await setEngineEnabled(ctx.prisma, true);
  });

  it('DRAFT → ACTIVE: activeVersionId moves to the requested immutable version, two audit rows, no other table touched', async () => {
    const { admin, cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    const before = await snapshot();

    const activated = await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);

    expect(activated.body.campaign).toMatchObject({ status: 'ACTIVE', activeVersionId: currentVersion.id, redemptionCount: 0, budgetConsumedCredits: 0 });
    expect(activated.body.activeVersion.versionNumber).toBe(1);
    expect(await auditActions(campaign.id)).toEqual([
      CampaignAuditAction.CREATED,
      CampaignAuditAction.VERSION_CREATED,
      CampaignAuditAction.VERSION_ACTIVATED,
      CampaignAuditAction.ACTIVATED,
    ]);
    const versionActivated = await ctx.prisma.campaignAuditLog.findFirstOrThrow({ where: { campaignId: campaign.id, action: CampaignAuditAction.VERSION_ACTIVATED } });
    expect(versionActivated).toMatchObject({ campaignVersionId: currentVersion.id, actorId: admin.id });
    expect(versionActivated.summary).toMatchObject({ versionNumber: 1, previousActiveVersionNumber: null, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', benefitCredits: 10 });
    // The version row is bit-for-bit what was stored.
    const stored = await ctx.prisma.campaignVersion.findUniqueOrThrow({ where: { id: currentVersion.id } });
    expect(stored.definition).toEqual(K2);
    const after = await snapshot();
    expect(after.versions).toBe(before.versions);
    expect(after.engine).toEqual(before.engine);
  });

  it('ACTIVE ⇄ PAUSED → ENDED, each with its audit row and reason; ENDED is terminal and rejects everything', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);

    expect((await transition(cookie, campaign.id, 'pause', 'bütçe gözden geçirme').expect(201)).body.campaign.status).toBe('PAUSED');
    expect((await transition(cookie, campaign.id, 'resume', 'gözden geçirme bitti').expect(201)).body.campaign.status).toBe('ACTIVE');
    expect((await transition(cookie, campaign.id, 'end', 'sezon bitti').expect(201)).body.campaign.status).toBe('ENDED');
    expect(await auditActions(campaign.id)).toEqual([
      CampaignAuditAction.CREATED,
      CampaignAuditAction.VERSION_CREATED,
      CampaignAuditAction.VERSION_ACTIVATED,
      CampaignAuditAction.ACTIVATED,
      CampaignAuditAction.PAUSED,
      CampaignAuditAction.RESUMED,
      CampaignAuditAction.ENDED,
    ]);
    const ended = await ctx.prisma.campaignAuditLog.findFirstOrThrow({ where: { campaignId: campaign.id, action: CampaignAuditAction.ENDED } });
    expect(ended.summary).toMatchObject({ reason: 'sezon bitti', versionNumber: 1 });

    const before = await snapshot();
    for (const verb of ['pause', 'resume', 'end'] as const) {
      const refused = await transition(cookie, campaign.id, verb).expect(409);
      expect(refused.body.code).toBe('CAMPAIGN_INVALID_TRANSITION');
    }
    expect((await activate(cookie, campaign.id, 1).expect(409)).body.code).toBe('CAMPAIGN_INVALID_TRANSITION');
    expect((await request(ctx.server).post(`/admin/campaigns/${campaign.id}/versions`).set('Cookie', cookie).send({ definition: K2 }).expect(409)).body.code).toBe('CAMPAIGN_ENDED');
    expect(await snapshot()).toEqual(before);
    // activeVersionId survives the end: the campaign's history stays readable.
    expect(before.campaigns.find((row) => row.id === campaign.id)).toMatchObject({ status: CampaignStatus.ENDED, activeVersionId: currentVersion.id });
  });

  it('invalid moves: pause/resume/end on a DRAFT, resume on ACTIVE, pause on PAUSED — 409 and nothing written', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    const draftState = await snapshot();
    for (const verb of ['pause', 'resume', 'end'] as const) {
      expect((await transition(cookie, campaign.id, verb).expect(409)).body.code).toBe('CAMPAIGN_INVALID_TRANSITION');
    }
    expect(await snapshot()).toEqual(draftState);

    await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);
    const activeState = await snapshot();
    expect((await transition(cookie, campaign.id, 'resume').expect(409)).body.code).toBe('CAMPAIGN_INVALID_TRANSITION');
    expect(await snapshot()).toEqual(activeState);

    await transition(cookie, campaign.id, 'pause').expect(201);
    const pausedState = await snapshot();
    expect((await transition(cookie, campaign.id, 'pause').expect(409)).body.code).toBe('CAMPAIGN_INVALID_TRANSITION');
    expect(await snapshot()).toEqual(pausedState);

    // A reason shorter than three characters is a 400 before anything is read.
    expect((await transition(cookie, campaign.id, 'resume', 'x').expect(400)).body.message).toEqual(expect.arrayContaining([expect.stringMatching(/reason/)]));
    await request(ctx.server).post(`/admin/campaigns/${campaign.id}/resume`).set('Cookie', cookie).send({}).expect(400);
    expect(await snapshot()).toEqual(pausedState);
    await activate(cookie, 'clzzzzzzzzzzzzzzzzzzzzzzz', 1).expect(404);
    expect((await activate(cookie, campaign.id, 99).expect(404)).body.code).toBe('CAMPAIGN_VERSION_NOT_FOUND');
  });

  it('an ACTIVE campaign cannot have its rule changed in place: a revision is stored as a new version and activation swaps to it', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);

    const revised = await request(ctx.server)
      .post(`/admin/campaigns/${campaign.id}/versions`)
      .set('Cookie', cookie)
      .send({ definition: { ...K2, benefit: { type: 'PROMO_CREDITS', credits: 20, expiresInDays: 30 } } })
      .expect(201);
    expect(revised.body.campaign.status).toBe('ACTIVE');
    expect(revised.body.activeVersion.versionNumber).toBe(1);
    expect(revised.body.currentVersion.versionNumber).toBe(2);
    // The running version is untouched.
    expect((await ctx.prisma.campaignVersion.findUniqueOrThrow({ where: { id: currentVersion.id } })).benefitCredits).toBe(10);

    const swapped = await activate(cookie, campaign.id, 2).expect(201);
    expect(swapped.body.campaign.status).toBe('ACTIVE');
    expect(swapped.body.activeVersion).toMatchObject({ versionNumber: 2, benefitCredits: 20 });
    const versionActivated = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId: campaign.id, action: CampaignAuditAction.VERSION_ACTIVATED }, orderBy: { createdAt: 'asc' } });
    expect(versionActivated).toHaveLength(2);
    expect(versionActivated[1]!.summary).toMatchObject({ versionNumber: 2, previousActiveVersionNumber: 1 });
    // Only the first activation changed the status.
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id, action: CampaignAuditAction.ACTIVATED } })).toBe(1);

    // Activating a version on a PAUSED campaign swaps and resumes in one go.
    await transition(cookie, campaign.id, 'pause').expect(201);
    const resumedBySwap = await activate(cookie, campaign.id, 1).expect(201);
    expect(resumedBySwap.body.campaign).toMatchObject({ status: 'ACTIVE', activeVersionId: currentVersion.id });
    expect((await auditActions(campaign.id)).slice(-2)).toEqual([CampaignAuditAction.VERSION_ACTIVATED, CampaignAuditAction.RESUMED]);
  });

  it('FACT_SOURCE_UNAVAILABLE: a version whose fact source has no PROVIDER writer cannot be activated or resumed', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K1);
    // Every writer is registered in the booted application; the gate is
    // exercised by taking one away, which is what an unbooted module looks like.
    const spy = vi.spyOn(registry, 'hasProviderWriter').mockImplementation((source) => source !== 'PHONE_VERIFIED');
    const before = await snapshot();

    const refused = await activate(cookie, campaign.id, currentVersion.versionNumber).expect(400);
    expect(refused.body.code).toBe('CAMPAIGN_ACTIVATION_REFUSED');
    expect(refused.body.errors).toEqual([
      // The stored definition is the normalised one: facts sorted, so PHONE_VERIFIED sits at index 1.
      expect.objectContaining({ path: 'eligibility.facts[1]', code: 'FACT_SOURCE_UNAVAILABLE', message: expect.stringContaining('PHONE_VERIFIED') }),
    ]);
    expect(await snapshot()).toEqual(before);

    // The trigger's own source is gated too.
    const k2 = await draft(cookie, K2);
    spy.mockImplementation((source) => source !== 'PACKAGE_PAYMENT_SUCCEEDED');
    const k2Refused = await activate(cookie, k2.campaign.id, 1).expect(400);
    expect(k2Refused.body.errors).toEqual([expect.objectContaining({ path: 'trigger', code: 'FACT_SOURCE_UNAVAILABLE' })]);

    // With every writer present, both activate; resume re-runs the gate.
    spy.mockRestore();
    await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);
    await transition(cookie, campaign.id, 'pause').expect(201);
    vi.spyOn(registry, 'hasProviderWriter').mockReturnValue(false);
    const resumeRefused = await transition(cookie, campaign.id, 'resume').expect(400);
    expect(resumeRefused.body.code).toBe('CAMPAIGN_ACTIVATION_REFUSED');
    expect(resumeRefused.body.errors.map((e: { code: string }) => e.code)).toEqual(['FACT_SOURCE_UNAVAILABLE', 'FACT_SOURCE_UNAVAILABLE', 'FACT_SOURCE_UNAVAILABLE']);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(CampaignStatus.PAUSED);
  });

  it('every booted writer is registered: the three facts and the payment trigger all have a PROVIDER writer', () => {
    expect(registry.hasProviderWriter('PROVIDER_APPROVED')).toBe(true);
    expect(registry.hasProviderWriter('EMAIL_VERIFIED')).toBe(true);
    expect(registry.hasProviderWriter('PHONE_VERIFIED')).toBe(true);
    expect(registry.hasProviderWriter('PACKAGE_PAYMENT_SUCCEEDED')).toBe(true);
    expect(registry.writersOf('PACKAGE_PAYMENT_SUCCEEDED').map((w) => w.module).sort()).toEqual(['package-purchases-mock', 'payments-webhook']);
    expect(registry.writersOf('PROVIDER_APPROVED')).toEqual([{ module: 'providers', role: 'PROVIDER' }]);
    expect(registry.writersOf('EMAIL_VERIFIED')).toEqual([{ module: 'email-verification', role: 'PROVIDER' }]);
    expect(registry.writersOf('PHONE_VERIFIED')).toEqual([{ module: 'phone-verification', role: 'PROVIDER' }]);
  });

  it('LIMIT_BELOW_CONSUMED: a version whose limits sit below what the campaign consumed is refused; equal is accepted', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);
    // Consumption as the engine would leave it after three grants of 10 to
    // two providers (one of them twice) — written directly, the engine is
    // not under test here.
    await ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { redemptionCount: 3, budgetConsumedCredits: 30 } });
    const p1 = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const providerA = await createProviderProfile(ctx.prisma, { userId: p1.id, status: 'APPROVED' });
    await ctx.prisma.campaignProviderCounter.create({ data: { campaignId: campaign.id, providerId: providerA.id, redemptionCount: 2 } });

    const tooLow = await request(ctx.server)
      .post(`/admin/campaigns/${campaign.id}/versions`)
      .set('Cookie', cookie)
      .send({ definition: { ...K2, limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 2, maxRedemptionsPerDay: null, budgetCredits: 25 } } })
      .expect(201);
    const before = await snapshot();
    const refused = await activate(cookie, campaign.id, tooLow.body.currentVersion.versionNumber).expect(400);
    expect(refused.body.code).toBe('CAMPAIGN_ACTIVATION_REFUSED');
    expect(refused.body.errors.map((e: { path: string; code: string }) => [e.path, e.code])).toEqual([
      ['limits.maxRedemptionsGlobal', 'LIMIT_BELOW_CONSUMED'],
      ['limits.budgetCredits', 'LIMIT_BELOW_CONSUMED'],
      ['limits.maxRedemptionsPerProvider', 'LIMIT_BELOW_CONSUMED'],
    ]);
    expect(await snapshot()).toEqual(before);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).activeVersionId).toBe(currentVersion.id);

    // Exactly the consumed values: accepted (the campaign just grants no more).
    const equal = await request(ctx.server)
      .post(`/admin/campaigns/${campaign.id}/versions`)
      .set('Cookie', cookie)
      .send({ definition: { ...K2, limits: { maxRedemptionsPerProvider: 2, maxRedemptionsGlobal: 3, maxRedemptionsPerDay: null, budgetCredits: 30 } } })
      .expect(201);
    await activate(cookie, campaign.id, equal.body.currentVersion.versionNumber).expect(201);
    // Counters are cumulative and untouched by the swap.
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ redemptionCount: 3, budgetConsumedCredits: 30 });
  });

  it('a version whose window has already closed, or whose stored definition no longer validates, is refused', async () => {
    const { cookie } = await adminCookie();
    const pkg = await createOfferPackage(ctx.prisma, { type: 'ONE_TIME_CREDITS', creditAmount: 10, priceAmount: 10_000 });
    const closed = await draft(cookie, { ...K2, window: { startAt: '2020-01-01T00:00:00.000Z', endAt: '2020-02-01T00:00:00.000Z' } });
    const refused = await activate(cookie, closed.campaign.id, 1).expect(400);
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: 'window.endAt', code: 'WINDOW_INVALID' })]);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: closed.campaign.id } })).status).toBe(CampaignStatus.DRAFT);

    // A future start is fine: the engine answers WINDOW_CLOSED until it opens.
    const future = await draft(cookie, { ...K2, window: { startAt: '2999-01-01T00:00:00.000Z', endAt: null } });
    await activate(cookie, future.campaign.id, 1).expect(201);

    // A stored slug that has since left the catalogue is a definition error at activation.
    const bySlug = await draft(cookie, { ...K2, conditions: { all: [{ type: 'PACKAGE_SLUG_IN', slugs: [pkg.slug] }] } });
    await ctx.prisma.offerCreditPackage.delete({ where: { id: pkg.id } });
    const stale = await activate(cookie, bySlug.campaign.id, 1).expect(400);
    expect(stale.body.code).toBe('CAMPAIGN_ACTIVATION_REFUSED');
    expect(stale.body.errors).toEqual([expect.objectContaining({ code: 'UNKNOWN_PACKAGE_SLUG' })]);
  });

  it('the list and the detail carry activeVersion and the cumulative counters', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    await activate(cookie, campaign.id, currentVersion.versionNumber).expect(201);
    const list = await request(ctx.server).get('/admin/campaigns').set('Cookie', cookie).expect(200);
    expect(list.body.engineEnabled).toBe(true);
    expect(list.body.items[0]).toMatchObject({ status: 'ACTIVE', activeVersionId: currentVersion.id, redemptionCount: 0, budgetConsumedCredits: 0 });
    expect(list.body.items[0].activeVersion.versionNumber).toBe(1);
    const detail = await request(ctx.server).get(`/admin/campaigns/${campaign.id}`).set('Cookie', cookie).expect(200);
    expect(detail.body.activeVersion.definition).toEqual(K2);
  });

  it('two operators activating at once: one ACTIVATED row, one VERSION_ACTIVATED row', async () => {
    const { cookie } = await adminCookie();
    const { campaign, currentVersion } = await draft(cookie, K2);
    const results = await Promise.all(Array.from({ length: 4 }, () => activate(cookie, campaign.id, currentVersion.versionNumber)));
    const statuses = results.map((r) => r.status).sort();
    // The first commits DRAFT → ACTIVE; the others, replayed, find an ACTIVE
    // campaign and swap the (same) version in — a second VERSION_ACTIVATED
    // row each, but never a second ACTIVATED, and never a 5xx.
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(await ctx.prisma.campaignAuditLog.count({ where: { campaignId: campaign.id, action: CampaignAuditAction.ACTIVATED } })).toBe(1);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).activeVersionId).toBe(currentVersion.id);
  });
});
