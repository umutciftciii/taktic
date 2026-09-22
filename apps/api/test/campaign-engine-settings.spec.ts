import { ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { createCampaignFixture, engineWriteSnapshot } from './campaign-fixtures';
import {
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * CMP-004 S4 — the campaign engine's switch, and who may throw it.
 *
 * `OperationsSettings.campaignEngineEnabled` is off by default, is read
 * fail-closed by every engine path, and until now had no writer. This gives
 * it one — `GET/PUT /operations-settings/campaign-engine`, SUPER_ADMIN only,
 * on the same contract as the other operations switches: a change and its
 * audit row commit together, a write that changes nothing writes nothing,
 * and concurrent writes leave a consistent chain. Nothing here turns the
 * engine on anywhere but this suite's own database.
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

const PATH = '/operations-settings/campaign-engine';

type View = {
  enabled: boolean;
  recentChanges: Array<{ setting: string; previousValue: string | null; newValue: string; changedBy: { id: string; name: string | null } | null }>;
};

async function admin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name: 'Op Admin' });
  return { user, cookie: await loginAs(ctx.prisma, user.id) };
}

const get = (cookie: string, expected = 200) => request(ctx.server).get(PATH).set('Cookie', cookie).expect(expected);
const put = (cookie: string, enabled: boolean, expected = 200) =>
  request(ctx.server).put(PATH).set('Cookie', cookie).send({ enabled }).expect(expected);

async function storedFlag() {
  const row = await ctx.prisma.operationsSettings.findUnique({ where: { id: 'singleton' }, select: { campaignEngineEnabled: true } });
  return row?.campaignEngineEnabled ?? null;
}

describe('GET /operations-settings/campaign-engine', () => {
  it('is off by default, with no settings row and no history', async () => {
    const { cookie } = await admin();
    const response = await get(cookie);
    expect(response.body).toEqual({ enabled: false, recentChanges: [] });
    expect(await storedFlag()).toBeNull();
  });

  it('is a SUPER_ADMIN endpoint both ways', async () => {
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await request(ctx.server).get(PATH).expect(401);
    await request(ctx.server).put(PATH).send({ enabled: true }).expect(401);
    for (const user of [provider, customer]) {
      const cookie = await loginAs(ctx.prisma, user.id);
      await get(cookie, 403);
      await put(cookie, true, 403);
    }
    expect(await storedFlag()).toBeNull();
    expect(await ctx.prisma.operationsSettingsChange.count()).toBe(0);
  });

  it('refuses a payload that is not a boolean', async () => {
    const { cookie } = await admin();
    await request(ctx.server).put(PATH).set('Cookie', cookie).send({ enabled: 'yes' }).expect(400);
    await request(ctx.server).put(PATH).set('Cookie', cookie).send({}).expect(400);
    expect(await storedFlag()).toBeNull();
  });
});

describe('PUT /operations-settings/campaign-engine', () => {
  it('records the first switch-on against the operator, a re-post of the same state writes nothing, and the switch-off chains', async () => {
    const { user, cookie } = await admin();

    const on = await put(cookie, true);
    expect(on.body.enabled).toBe(true);
    expect(await storedFlag()).toBe(true);
    expect((on.body as View).recentChanges).toEqual([
      expect.objectContaining({ setting: 'campaignEngineEnabled', previousValue: null, newValue: 'true', changedBy: { id: user.id, name: 'Op Admin' } }),
    ]);

    const again = await put(cookie, true);
    expect((again.body as View).recentChanges).toHaveLength(1);
    expect(await ctx.prisma.operationsSettingsChange.count({ where: { setting: 'campaignEngineEnabled' } })).toBe(1);

    const off = await put(cookie, false);
    expect(off.body.enabled).toBe(false);
    expect(await storedFlag()).toBe(false);
    expect((off.body as View).recentChanges.map((change) => [change.previousValue, change.newValue])).toEqual([
      ['true', 'false'],
      [null, 'true'],
    ]);

    // Switching off a switch that is already off (no row, or a false row) is not a decision.
    await resetDatabase(ctx.prisma);
    const { cookie: fresh } = await admin();
    const noop = await put(fresh, false);
    expect(noop.body).toEqual({ enabled: false, recentChanges: [] });
    expect(await storedFlag()).toBeNull();
  });

  it('touches no other operations setting', async () => {
    const { cookie } = await admin();
    await ctx.prisma.operationsSettings.create({
      data: { id: 'singleton', unviewedOfferRefundWindowHours: 72, unviewedOfferRefundSchedulerEnabled: true, marketplaceAutoPublishEnabled: true },
    });
    await put(cookie, true);
    const row = await ctx.prisma.operationsSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(row).toMatchObject({ unviewedOfferRefundWindowHours: 72, unviewedOfferRefundSchedulerEnabled: true, marketplaceAutoPublishEnabled: true, campaignEngineEnabled: true });
  });

  it('leaves one consistent chain under concurrent writes', async () => {
    const { cookie } = await admin();
    const wanted = [true, false, true, true, false, true];
    const responses = await Promise.all(wanted.map((enabled) => request(ctx.server).put(PATH).set('Cookie', cookie).send({ enabled })));
    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    const changes = await ctx.prisma.operationsSettingsChange.findMany({
      where: { setting: 'campaignEngineEnabled' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // Every change continues the one before it, the first from "no row", and
    // the last one is the stored state — no change was recorded twice and no
    // change was lost.
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]!.previousValue).toBeNull();
    for (let index = 1; index < changes.length; index += 1) {
      expect(changes[index]!.previousValue).toBe(changes[index - 1]!.newValue);
      expect(changes[index]!.previousValue).not.toBe(changes[index]!.newValue);
    }
    expect(String(await storedFlag())).toBe(changes.at(-1)!.newValue);
  });
});

describe('what the switch does and does not do', () => {
  async function pendingProvider() {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: `0555${uniqueSuffix().padStart(7, '0').slice(-7)}` });
    return createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.PENDING_REVIEW });
  }
  const approve = (cookie: string, providerId: string) =>
    request(ctx.server).patch(`/providers/${providerId}/status`).set('Cookie', cookie).send({ status: ProviderStatus.APPROVED }).expect(200);

  it('off: a real event raises nothing; on: the next event raises one event and one grant; off again: nothing — and switching on invents no past event', async () => {
    const { cookie } = await admin();
    await createCampaignFixture(ctx.prisma, { credits: 7 });

    // Off (default): an approval writes no event.
    const before = await pendingProvider();
    await approve(cookie, before.id);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);

    // On: the approval before the switch is not raised retroactively; the
    // next approval is, once, and the worker grants once.
    await put(cookie, true);
    expect(await ctx.prisma.campaignTriggerEvent.count()).toBe(0);
    const during = await pendingProvider();
    await approve(cookie, during.id);
    expect(await ctx.prisma.campaignTriggerEvent.findMany()).toMatchObject([{ providerId: during.id, trigger: 'PROVIDER_APPROVED', status: 'PENDING' }]);
    const run = await worker.runOnce();
    expect(run.outcomes.map((entry) => entry.outcome)).toEqual(['SETTLED']);
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: during.id, status: 'GRANTED' } })).toBe(1);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { providerId: during.id, type: 'CAMPAIGN_GRANT' } })).toBe(1);

    // Off again: no new event, and the worker claims nothing.
    await put(cookie, false);
    const snapshot = await engineWriteSnapshot(ctx.prisma);
    const after = await pendingProvider();
    await approve(cookie, after.id);
    expect(await engineWriteSnapshot(ctx.prisma)).toEqual(snapshot);
    expect((await worker.runOnce()).skipped).toBe('ENGINE_DISABLED');
  });

  it('on with no ACTIVE campaign: the event is raised and evaluated, and nothing is granted', async () => {
    const { cookie } = await admin();
    await createCampaignFixture(ctx.prisma, { status: 'DRAFT' });
    await put(cookie, true);
    const provider = await pendingProvider();
    await approve(cookie, provider.id);
    expect(await ctx.prisma.campaignTriggerEvent.count({ where: { status: 'PENDING' } })).toBe(1);

    const run = await worker.runOnce();
    expect(run.skipped).toBeNull();
    expect(run.outcomes.map((entry) => entry.outcome)).toEqual(['EVALUATED']);
    expect(await ctx.prisma.campaignRedemption.count()).toBe(0);
    expect(await ctx.prisma.promoCreditLot.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { type: 'CAMPAIGN_GRANT' } })).toBe(0);
  });
});
