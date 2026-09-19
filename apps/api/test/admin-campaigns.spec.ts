import { CampaignAuditAction, CampaignStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OPERATIONS_SETTINGS_ID } from '../src/modules/operations-settings/operations-settings.service';
import {
  createOfferPackage,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * CMP-002 S1 — the SUPER_ADMIN campaign draft surface.
 *
 * A campaign is a row plus immutable versions. Every write here goes through
 * the validator first and lands in one Serializable transaction, or not at
 * all; a version row, once written, is never updated; and nothing in this
 * module can grant a credit — there is no activation, no evaluation and no
 * ledger write, and the engine switch has no endpoint that turns it on.
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

const K2 = {
  schemaVersion: 1,
  trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
  conditions: {
    all: [
      { type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' },
      { type: 'MIN_PAID_AMOUNT', minor: 10000, currency: 'TRY' },
      { type: 'NO_PRIOR_REVOCATION' },
    ],
  },
  benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
  limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 1000, maxRedemptionsPerDay: null, budgetCredits: 10000 },
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
  limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: null, maxRedemptionsPerDay: null, budgetCredits: null },
  window: { startAt: null, endAt: null },
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 100,
};

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

async function rowCounts() {
  return {
    campaigns: await ctx.prisma.campaign.count(),
    versions: await ctx.prisma.campaignVersion.count(),
    audit: await ctx.prisma.campaignAuditLog.count(),
    credits: await ctx.prisma.providerCreditTransaction.count(),
  };
}

function createCampaign(cookie: string, body: Record<string, unknown>) {
  return request(ctx.server).post('/admin/campaigns').set('Cookie', cookie).send(body);
}

describe('access', () => {
  it('refuses anonymous, CUSTOMER and PROVIDER sessions on every route', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const providerCookie = await loginAs(ctx.prisma, provider.id);

    await request(ctx.server).get('/admin/campaigns').expect(401);
    await request(ctx.server).post('/admin/campaigns').send({}).expect(401);
    await request(ctx.server).post('/admin/campaigns/validate').send({ definition: K2 }).expect(401);

    for (const cookie of [customerCookie, providerCookie]) {
      await request(ctx.server).get('/admin/campaigns').set('Cookie', cookie).expect(403);
      await request(ctx.server).get('/admin/campaigns/anything').set('Cookie', cookie).expect(403);
      await createCampaign(cookie, { key: 'k', name: 'n', definition: K2 }).expect(403);
      await request(ctx.server).post('/admin/campaigns/validate').set('Cookie', cookie).send({ definition: K2 }).expect(403);
      await request(ctx.server).post('/admin/campaigns/x/versions').set('Cookie', cookie).send({ definition: K2 }).expect(403);
    }
    expect(await rowCounts()).toEqual({ campaigns: 0, versions: 0, audit: 0, credits: 0 });
  });
});

describe('creating a draft', () => {
  it('writes the campaign, version 1 and two audit entries in one go, engine off', async () => {
    const { admin, cookie } = await adminCookie();

    const response = await createCampaign(cookie, {
      key: 'paket-bonusu',
      name: 'Paket bonusu',
      definition: K2,
    }).expect(201);

    expect(response.body.campaign).toMatchObject({
      key: 'paket-bonusu',
      name: 'Paket bonusu',
      status: 'DRAFT',
      createdBy: { id: admin.id, name: admin.name },
    });
    expect(response.body.currentVersion).toMatchObject({
      versionNumber: 1,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      factSetKey: null,
      eligibilityFacts: [],
      benefitType: 'PROMO_CREDITS',
      benefitCredits: 10,
      benefitExpiresInDays: 30,
      maxRedemptionsPerProvider: 1,
      maxRedemptionsGlobal: 1000,
      maxRedemptionsPerDay: null,
      budgetCredits: 10000,
      stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
      priority: 100,
      definition: K2,
      createdBy: { id: admin.id, name: admin.name },
    });
    expect(response.body.engineEnabled).toBe(false);

    const campaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { key: 'paket-bonusu' } });
    const versions = await ctx.prisma.campaignVersion.findMany({ where: { campaignId: campaign.id } });
    expect(versions).toHaveLength(1);
    expect(campaign.currentVersionId).toBe(versions[0]!.id);
    expect(campaign.status).toBe(CampaignStatus.DRAFT);

    const audit = await ctx.prisma.campaignAuditLog.findMany({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((entry) => entry.action)).toEqual([
      CampaignAuditAction.CREATED,
      CampaignAuditAction.VERSION_CREATED,
    ]);
    expect(audit.every((entry) => entry.actorId === admin.id)).toBe(true);
    expect(audit[1]!.campaignVersionId).toBe(versions[0]!.id);
    expect(audit[1]!.summary).toEqual({
      versionNumber: 1,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      benefitCredits: 10,
      benefitExpiresInDays: 30,
      maxRedemptionsPerProvider: 1,
      changedFields: [],
    });
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);
  });

  it('stores the eligibility fact set in canonical order with its key', async () => {
    const { cookie } = await adminCookie();
    const response = await createCampaign(cookie, { key: 'hosgeldin', name: 'Hoş geldin', definition: K1 }).expect(201);
    expect(response.body.currentVersion.eligibilityFacts).toEqual(['EMAIL_VERIFIED', 'PHONE_VERIFIED', 'PROVIDER_APPROVED']);
    expect(response.body.currentVersion.factSetKey).toBe('EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED');
    expect(response.body.currentVersion.definition.eligibility.facts).toEqual(['EMAIL_VERIFIED', 'PHONE_VERIFIED', 'PROVIDER_APPROVED']);
  });

  it('writes nothing when the definition is invalid, and names every error', async () => {
    const { cookie } = await adminCookie();
    const response = await createCampaign(cookie, {
      key: 'bozuk',
      name: 'Bozuk',
      definition: { ...K2, benefit: { type: 'PROMO_CREDITS', credits: 0, expiresInDays: 30 }, priority: 5000 },
    }).expect(400);

    expect(response.body.code).toBe('CAMPAIGN_DEFINITION_INVALID');
    expect(response.body.errors).toEqual([
      { path: 'benefit.credits', code: 'BENEFIT_INVALID', message: expect.any(String) },
      { path: 'priority', code: 'PRIORITY_INVALID', message: expect.any(String) },
    ]);
    expect(await rowCounts()).toEqual({ campaigns: 0, versions: 0, audit: 0, credits: 0 });
  });

  it('rejects a package slug the catalogue does not carry, and accepts one it does', async () => {
    const { cookie } = await adminCookie();
    const pkg = await createOfferPackage(ctx.prisma, { type: 'ONE_TIME_CREDITS' as never, priceAmount: 9900 });
    const withSlugs = (slugs: string[]) => ({
      ...K2,
      conditions: { all: [{ type: 'PACKAGE_SLUG_IN', slugs }] },
    });

    const refused = await createCampaign(cookie, { key: 'slug-yok', name: 'x', definition: withSlugs([pkg.slug, 'yok-boyle-paket']) }).expect(400);
    expect(refused.body.errors).toEqual([
      { path: 'conditions.all[0].slugs[1]', code: 'UNKNOWN_PACKAGE_SLUG', message: expect.any(String) },
    ]);
    expect(await rowCounts()).toMatchObject({ campaigns: 0, versions: 0 });

    await createCampaign(cookie, { key: 'slug-var', name: 'x', definition: withSlugs([pkg.slug]) }).expect(201);
  });

  it('refuses a duplicate key, a malformed key and a missing name', async () => {
    const { cookie } = await adminCookie();
    await createCampaign(cookie, { key: 'ayni', name: 'Bir', definition: K2 }).expect(201);
    const dup = await createCampaign(cookie, { key: 'ayni', name: 'İki', definition: K2 }).expect(409);
    expect(dup.body.code).toBe('CAMPAIGN_KEY_TAKEN');
    await createCampaign(cookie, { key: 'Büyük Harf', name: 'x', definition: K2 }).expect(400);
    await createCampaign(cookie, { key: 'bos-ad', name: '', definition: K2 }).expect(400);
    await createCampaign(cookie, { key: 'tanim-yok', name: 'x' }).expect(400);
    await createCampaign(cookie, { key: 'fazla-alan', name: 'x', definition: K2, status: 'ACTIVE' }).expect(400);
    expect(await rowCounts()).toMatchObject({ campaigns: 1, versions: 1, audit: 2 });
  });
});

describe('validate-only', () => {
  it('answers without writing, for a valid and an invalid definition', async () => {
    const { cookie } = await adminCookie();
    const before = await rowCounts();

    const valid = await request(ctx.server).post('/admin/campaigns/validate').set('Cookie', cookie).send({ definition: K1 }).expect(201);
    expect(valid.body).toEqual({
      valid: true,
      errors: [],
      summary: {
        trigger: 'PROVIDER_ELIGIBILITY_REACHED',
        factSetKey: 'EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED',
        eligibilityFacts: ['EMAIL_VERIFIED', 'PHONE_VERIFIED', 'PROVIDER_APPROVED'],
        conditionCount: 1,
        benefitCredits: 5,
        benefitExpiresInDays: 14,
      },
    });

    const invalid = await request(ctx.server)
      .post('/admin/campaigns/validate')
      .set('Cookie', cookie)
      .send({ definition: { ...K2, trigger: 'PROVIDER_APPROVED', conditions: { all: [{ type: 'EMAIL_VERIFIED' }] } } })
      .expect(201);
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.summary).toBeNull();
    expect(invalid.body.errors.map((e: { code: string }) => e.code)).toEqual(['USE_ELIGIBILITY_TRIGGER']);

    await request(ctx.server).post('/admin/campaigns/validate').set('Cookie', cookie).send({ definition: 'not-an-object' }).expect(400);
    await request(ctx.server).post('/admin/campaigns/validate').set('Cookie', cookie).send({}).expect(400);

    expect(await rowCounts()).toEqual(before);
  });
});

describe('revising a draft', () => {
  it('adds an immutable version, moves the pointer and leaves version 1 byte for byte', async () => {
    const { admin, cookie } = await adminCookie();
    const created = await createCampaign(cookie, { key: 'rev', name: 'Rev', definition: K2 }).expect(201);
    const campaignId = created.body.campaign.id as string;
    const v1Before = await ctx.prisma.campaignVersion.findUniqueOrThrow({
      where: { campaignId_versionNumber: { campaignId, versionNumber: 1 } },
    });

    const editor = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name: 'İkinci Yönetici' });
    const editorCookie = await loginAs(ctx.prisma, editor.id);
    const revised = await request(ctx.server)
      .post(`/admin/campaigns/${campaignId}/versions`)
      .set('Cookie', editorCookie)
      .send({ definition: { ...K2, benefit: { type: 'PROMO_CREDITS', credits: 15, expiresInDays: 30 }, priority: 50 } })
      .expect(201);

    expect(revised.body.currentVersion).toMatchObject({
      versionNumber: 2,
      benefitCredits: 15,
      priority: 50,
      createdBy: { id: editor.id, name: 'İkinci Yönetici' },
    });
    expect(revised.body.campaign.status).toBe('DRAFT');

    const v1After = await ctx.prisma.campaignVersion.findUniqueOrThrow({ where: { id: v1Before.id } });
    expect(v1After).toEqual(v1Before);

    const campaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.currentVersionId).toBe(revised.body.currentVersion.id);
    expect(campaign.createdById).toBe(admin.id);

    const audit = await ctx.prisma.campaignAuditLog.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
    expect(audit).toHaveLength(3);
    expect(audit[2]).toMatchObject({
      action: CampaignAuditAction.VERSION_CREATED,
      actorId: editor.id,
      campaignVersionId: revised.body.currentVersion.id,
      summary: {
        versionNumber: 2,
        trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
        benefitCredits: 15,
        benefitExpiresInDays: 30,
        maxRedemptionsPerProvider: 1,
        changedFields: ['benefit', 'priority'],
      },
    });
    // The audit summary is structural: nothing the operator typed is in it.
    expect(JSON.stringify(audit.map((entry) => entry.summary))).not.toContain('Rev');
  });

  it('writes nothing for an invalid revision, and 404s an unknown campaign without a body that leaks', async () => {
    const { cookie } = await adminCookie();
    const created = await createCampaign(cookie, { key: 'rev2', name: 'Rev', definition: K2 }).expect(201);
    const campaignId = created.body.campaign.id as string;
    const before = await rowCounts();

    const refused = await request(ctx.server)
      .post(`/admin/campaigns/${campaignId}/versions`)
      .set('Cookie', cookie)
      .send({ definition: { ...K2, stackPolicy: 'ADDITIVE' } })
      .expect(400);
    expect(refused.body.code).toBe('CAMPAIGN_DEFINITION_INVALID');
    expect(await rowCounts()).toEqual(before);

    const missing = await request(ctx.server)
      .post('/admin/campaigns/clzzzzzzzzzzzzzzzzzzzzzzz/versions')
      .set('Cookie', cookie)
      .send({ definition: K2 })
      .expect(404);
    expect(missing.body.code).toBe('CAMPAIGN_NOT_FOUND');
    expect(JSON.stringify(missing.body)).not.toContain('rev2');
    await request(ctx.server).get('/admin/campaigns/clzzzzzzzzzzzzzzzzzzzzzzz').set('Cookie', cookie).expect(404);
  });

  it('refuses a revision on a campaign that is no longer a draft', async () => {
    const { cookie } = await adminCookie();
    const created = await createCampaign(cookie, { key: 'ended', name: 'x', definition: K2 }).expect(201);
    // No endpoint moves a campaign out of DRAFT in this slice; the gate is
    // exercised by writing the column directly.
    await ctx.prisma.campaign.update({ where: { id: created.body.campaign.id }, data: { status: CampaignStatus.ENDED } });
    const refused = await request(ctx.server)
      .post(`/admin/campaigns/${created.body.campaign.id}/versions`)
      .set('Cookie', cookie)
      .send({ definition: K2 })
      .expect(409);
    expect(refused.body.code).toBe('CAMPAIGN_NOT_DRAFT');
    expect(await ctx.prisma.campaignVersion.count()).toBe(1);
  });

  it('numbers concurrent saves monotonically with no gap and no collision', async () => {
    const { cookie } = await adminCookie();
    const created = await createCampaign(cookie, { key: 'yaris', name: 'Yarış', definition: K2 }).expect(201);
    const campaignId = created.body.campaign.id as string;

    const attempts = 8;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        request(ctx.server)
          .post(`/admin/campaigns/${campaignId}/versions`)
          .set('Cookie', cookie)
          .send({ definition: { ...K2, priority: 100 + i } }),
      ),
    );

    const accepted = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    expect(accepted.length + conflicted.length).toBe(attempts);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    for (const r of conflicted) {
      expect(r.body.code).toBe('CONCURRENT_MODIFICATION');
    }

    const versions = await ctx.prisma.campaignVersion.findMany({ where: { campaignId }, orderBy: { versionNumber: 'asc' } });
    expect(versions.map((v) => v.versionNumber)).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
    expect(versions).toHaveLength(1 + accepted.length);

    const campaign = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.currentVersionId).toBe(versions[versions.length - 1]!.id);
    const auditCount = await ctx.prisma.campaignAuditLog.count({ where: { campaignId, action: CampaignAuditAction.VERSION_CREATED } });
    expect(auditCount).toBe(versions.length);
  });
});

describe('reading', () => {
  it('lists drafts newest first with a bounded page, and details one with its history', async () => {
    const { cookie } = await adminCookie();
    const keys: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const key = `kamp-${uniqueSuffix()}`;
      keys.push(key);
      await createCampaign(cookie, { key, name: `Kampanya ${i}`, definition: K2 }).expect(201);
    }

    const page = await request(ctx.server).get('/admin/campaigns?limit=2').set('Cookie', cookie).expect(200);
    expect(page.body.engineEnabled).toBe(false);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.items[0]).toMatchObject({
      key: keys[2],
      status: 'DRAFT',
      currentVersion: { versionNumber: 1, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', benefitCredits: 10, benefitExpiresInDays: 30 },
    });
    expect(page.body.items[0].currentVersion.definition).toBeUndefined();
    expect(typeof page.body.nextCursor).toBe('string');

    const rest = await request(ctx.server).get(`/admin/campaigns?limit=2&cursor=${page.body.nextCursor}`).set('Cookie', cookie).expect(200);
    expect(rest.body.items.map((item: { key: string }) => item.key)).toEqual([keys[0]]);
    expect(rest.body.nextCursor).toBeNull();

    await request(ctx.server).get('/admin/campaigns?limit=0').set('Cookie', cookie).expect(400);
    await request(ctx.server).get('/admin/campaigns?limit=51').set('Cookie', cookie).expect(400);

    const id = page.body.items[0].id as string;
    await request(ctx.server).post(`/admin/campaigns/${id}/versions`).set('Cookie', cookie).send({ definition: K1 }).expect(201);
    const detail = await request(ctx.server).get(`/admin/campaigns/${id}`).set('Cookie', cookie).expect(200);
    expect(detail.body.engineEnabled).toBe(false);
    expect(detail.body.campaign.key).toBe(keys[2]);
    expect(detail.body.currentVersion.versionNumber).toBe(2);
    expect(detail.body.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(detail.body.versions[1].definition).toEqual(K2);
    expect(detail.body.audit.map((a: { action: string }) => a.action)).toEqual(['VERSION_CREATED', 'VERSION_CREATED', 'CREATED']);
    expect(detail.body.audit[0].actor).toEqual({ id: expect.any(String), name: expect.any(String) });
  });

  it('reports the engine switch fail-closed: no row, a false row, a true row', async () => {
    const { admin, cookie } = await adminCookie();
    const read = async () =>
      (await request(ctx.server).get('/admin/campaigns').set('Cookie', cookie).expect(200)).body.engineEnabled as boolean;

    expect(await ctx.prisma.operationsSettings.findUnique({ where: { id: OPERATIONS_SETTINGS_ID } })).toBeNull();
    expect(await read()).toBe(false);

    await ctx.prisma.operationsSettings.create({
      data: { id: OPERATIONS_SETTINGS_ID, unviewedOfferRefundWindowHours: 48, updatedById: admin.id },
    });
    expect(await read()).toBe(false);

    // Only a direct column write can turn it on in this slice: no endpoint does.
    await ctx.prisma.operationsSettings.update({ where: { id: OPERATIONS_SETTINGS_ID }, data: { campaignEngineEnabled: true } });
    expect(await read()).toBe(true);
    await request(ctx.server).put('/operations-settings').set('Cookie', cookie).send({ campaignEngineEnabled: false }).expect(400);
  });
});
