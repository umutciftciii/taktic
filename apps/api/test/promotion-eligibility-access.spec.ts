import { AdminPermission, ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignEvaluationWorker } from '../src/modules/campaigns/engine/campaign-evaluation.worker';
import { createCampaignFixture, setEngineEnabled } from './campaign-fixtures';
import {
  createAdminWithPermissions,
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
 * The fraud reviewer's access matrix (CMP-006 PR-C.1).
 *
 * The reviewer role is made of existing, separately assigned permissions:
 *   PROMOTION_ELIGIBILITY_REVIEW  the queue, the snapshot, the decision
 *   PROVIDERS_READ_DETAIL         the provider page the queue links to
 *   PROVIDER_REVIEWS_READ         the provider's customer reviews on that page
 * and the raw registration number is a fourth, separate one
 * (PROVIDER_REGISTRATION_READ_SENSITIVE). SUPER_ADMIN holds all of them
 * implicitly. No route here is opened by role: every one names its permission.
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
  await setEngineEnabled(ctx.prisma, true);
});

const TCKN = '10000000146';

const REVIEWER = [
  AdminPermission.PROMOTION_ELIGIBILITY_REVIEW,
  AdminPermission.PROVIDERS_READ_DETAIL,
  AdminPermission.PROVIDER_REVIEWS_READ,
];

type Actor =
  | 'superAdmin'
  | 'reviewer'
  | 'sensitiveOnly'
  | 'reviewerSensitive'
  | 'reviewContextSensitive'
  | 'reviewNoDetailSensitive'
  | 'detailSensitive'
  | 'none';

const SENSITIVE = AdminPermission.PROVIDER_REGISTRATION_READ_SENSITIVE;

/** Cookies per actor, and the account id behind each (the access log names the reader). */
async function actors(): Promise<{ cookie: Record<Actor, string>; id: Record<Actor, string> }> {
  const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const entries: Array<[Actor, string]> = [['superAdmin', root.id]];
  const permissionsOf: Record<Exclude<Actor, 'superAdmin'>, AdminPermission[]> = {
    reviewer: REVIEWER,
    sensitiveOnly: [SENSITIVE],
    reviewerSensitive: [...REVIEWER, SENSITIVE],
    // The raw read's own context (PR-C.2) — the review and the provider page —
    // without the customer-reviews permission, which is not part of it.
    reviewContextSensitive: [AdminPermission.PROMOTION_ELIGIBILITY_REVIEW, AdminPermission.PROVIDERS_READ_DETAIL, SENSITIVE],
    // Each half of the context alone is not enough.
    reviewNoDetailSensitive: [AdminPermission.PROMOTION_ELIGIBILITY_REVIEW, SENSITIVE],
    detailSensitive: [AdminPermission.PROVIDERS_READ_DETAIL, SENSITIVE],
    none: [AdminPermission.DASHBOARD_READ],
  };
  for (const [actor, permissions] of Object.entries(permissionsOf) as Array<[Actor, AdminPermission[]]>) {
    entries.push([actor, (await createAdminWithPermissions(ctx.prisma, permissions)).admin.id]);
  }
  const cookie = {} as Record<Actor, string>;
  const id = {} as Record<Actor, string>;
  for (const [actor, userId] of entries) {
    cookie[actor] = await loginAs(ctx.prisma, userId);
    id[actor] = userId;
  }
  return { cookie, id };
}

async function cookies(): Promise<Record<Actor, string>> {
  return (await actors()).cookie;
}

/** A provider declared as a sole proprietor, approved, and held by the gate (the same number is already promoted elsewhere). */
async function heldProvider() {
  await createCampaignFixture(ctx.prisma, { trigger: 'PROVIDER_APPROVED' });
  const worker = ctx.app.get(CampaignEvaluationWorker);
  const root = await loginAs(ctx.prisma, (await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN })).id);
  const make = async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: `0555${uniqueSuffix().padStart(7, '0').slice(-7)}` });
    await ctx.prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() } });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.PENDING_REVIEW });
    await declareBusinessRegistration(ctx.prisma, provider.id, { type: 'SOLE_PROPRIETOR_TR_ID', number: TCKN });
    return provider;
  };
  const first = await make();
  await request(ctx.server).patch(`/providers/${first.id}/status`).set('Cookie', root).send({ status: 'APPROVED' }).expect(200);
  await worker.runOnce();
  const provider = await make();
  await request(ctx.server).patch(`/providers/${provider.id}/status`).set('Cookie', root).send({ status: 'APPROVED' }).expect(200);
  await worker.runOnce();
  const event = await ctx.prisma.campaignTriggerEvent.findUniqueOrThrow({ where: { triggerEventKey: `PROVIDER_APPROVED:${provider.id}` } });
  expect(event.status).toBe('HELD_FOR_REVIEW');
  return { provider, event, worker };
}

const REASON = 'Belgeler incelendi; aynı işletmenin ikinci şubesi.';

describe('the fraud reviewer access matrix', () => {
  it('each route answers exactly as the assigned permissions say, and no body but a granted raw read carries the number', async () => {
    const { provider, event } = await heldProvider();
    const { cookie, id } = await actors();
    const routes = {
      queue: () => request(ctx.server).get('/admin/promotion-eligibility/holds'),
      providerHolds: () => request(ctx.server).get(`/admin/promotion-eligibility/holds?filter=all&providerId=${provider.id}`),
      hold: () => request(ctx.server).get(`/admin/promotion-eligibility/holds/${event.id}`),
      detail: () => request(ctx.server).get(`/providers/${provider.id}/admin-detail`),
      reviews: () => request(ctx.server).get(`/provider-reviews/by-provider/${provider.id}`),
      raw: () => request(ctx.server).get(`/providers/${provider.id}/business-registration/raw`),
      rawUnknown: () => request(ctx.server).get('/providers/no-such-provider/business-registration/raw'),
    };
    const R = { queue: 403, providerHolds: 403, hold: 403, detail: 403, reviews: 403, raw: 403, rawUnknown: 403 };
    const REVIEW_OK = { queue: 200, providerHolds: 200, hold: 200, detail: 200 };
    const expected: Record<Actor, Record<keyof typeof routes, number>> = {
      superAdmin: { ...REVIEW_OK, reviews: 200, raw: 200, rawUnknown: 404 },
      reviewer: { ...REVIEW_OK, reviews: 200, raw: 403, rawUnknown: 403 },
      sensitiveOnly: { ...R },
      reviewerSensitive: { ...REVIEW_OK, reviews: 200, raw: 200, rawUnknown: 404 },
      reviewContextSensitive: { ...REVIEW_OK, reviews: 403, raw: 200, rawUnknown: 404 },
      reviewNoDetailSensitive: { ...R, queue: 200, providerHolds: 200, hold: 200 },
      detailSensitive: { ...R, detail: 200 },
      none: { ...R },
    };

    const granted = new Map<Actor, number>();
    for (const actor of Object.keys(expected) as Actor[]) {
      for (const [name, open] of Object.entries(routes) as Array<[keyof typeof routes, () => request.Test]>) {
        const before = await ctx.prisma.sensitiveDataAccessLog.count();
        const response = await open().set('Cookie', cookie[actor]);
        expect(response.status, `${actor} ${name}`).toBe(expected[actor][name]);
        const after = await ctx.prisma.sensitiveDataAccessLog.count();
        if (name === 'raw' && response.status === 200) {
          granted.set(actor, (granted.get(actor) ?? 0) + 1);
          expect(response.body.registration.number).toBe(TCKN);
          expect(response.headers['cache-control']).toBe('no-store');
          // Exactly one access row per granted read, naming this reader.
          expect(after - before, `${actor} raw audit`).toBe(1);
        } else {
          // Refusals (403), unknown providers (404) and every other route write no access row …
          expect(after - before, `${actor} ${name} audit`).toBe(0);
          // … and never carry the number, in a body or an error.
          expect(JSON.stringify(response.body ?? null), `${actor} ${name} must not carry the raw number`).not.toContain(TCKN);
        }
      }
    }

    expect([...granted.keys()].sort()).toEqual(['reviewContextSensitive', 'reviewerSensitive', 'superAdmin']);
    const log = await ctx.prisma.sensitiveDataAccessLog.findMany();
    expect(log.map((row) => row.actorId).sort()).toEqual([id.reviewContextSensitive, id.reviewerSensitive, id.superAdmin].sort());
    expect(log.every((row) => row.providerId === provider.id)).toBe(true);
    expect(JSON.stringify(log)).not.toContain(TCKN);
    // The sensitive permission alone read nothing and left nothing.
    expect(log.some((row) => row.actorId === id.sensitiveOnly)).toBe(false);
  });

  it('the reviewer sees the provider and its eligibility context masked, and decides; the others cannot decide', async () => {
    const { provider, event } = await heldProvider();
    const as = await cookies();

    const detail = await request(ctx.server).get(`/providers/${provider.id}/admin-detail`).set('Cookie', as.reviewer).expect(200);
    expect(detail.body.businessRegistration).toMatchObject({ type: 'SOLE_PROPRIETOR_TR_ID', numberMasked: '*********46' });
    const context = await request(ctx.server)
      .get(`/admin/promotion-eligibility/holds?filter=all&providerId=${provider.id}`)
      .set('Cookie', as.reviewer)
      .expect(200);
    expect(context.body.items).toMatchObject([{ eventId: event.id, provider: { id: provider.id }, review: null }]);

    for (const actor of ['sensitiveOnly', 'none'] as const) {
      const refused = await request(ctx.server)
        .post(`/admin/promotion-eligibility/holds/${event.id}/decision`)
        .set('Cookie', as[actor])
        .send({ decision: 'ELIGIBLE', reason: REASON })
        .expect(403);
      expect(JSON.stringify(refused.body)).not.toContain(TCKN);
    }
    expect(await ctx.prisma.promotionEligibilityReview.count()).toBe(0);

    const decided = await request(ctx.server)
      .post(`/admin/promotion-eligibility/holds/${event.id}/decision`)
      .set('Cookie', as.reviewer)
      .send({ decision: 'INELIGIBLE', reason: REASON })
      .expect(201);
    expect(JSON.stringify(decided.body)).not.toContain(TCKN);
    const conflict = await request(ctx.server)
      .post(`/admin/promotion-eligibility/holds/${event.id}/decision`)
      .set('Cookie', as.reviewerSensitive)
      .send({ decision: 'ELIGIBLE', reason: REASON })
      .expect(409);
    expect(JSON.stringify(conflict.body)).not.toContain(TCKN);
    expect(await ctx.prisma.promotionEligibilityReview.count()).toBe(1);
  });

  it('two reviewers deciding at once: one decision, one grant, one count', async () => {
    const { provider, event, worker } = await heldProvider();
    const as = await cookies();
    const responses = await Promise.all(
      (['reviewer', 'reviewerSensitive'] as const).map((actor) =>
        request(ctx.server)
          .post(`/admin/promotion-eligibility/holds/${event.id}/decision`)
          .set('Cookie', as[actor])
          .send({ decision: 'ELIGIBLE', reason: REASON }),
      ),
    );
    // One 201 and one 409 — never two recorded decisions, and never a 409 read as success.
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(['ELIGIBILITY_DECISION_ALREADY_RECORDED', 'CONCURRENT_MODIFICATION']).toContain(loser.body.code);

    await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()]);
    // The final invariant, read from the rows.
    expect(await ctx.prisma.promotionEligibilityReview.count({ where: { triggerEventId: event.id } })).toBe(1);
    expect(await ctx.prisma.campaignRedemption.count({ where: { providerId: provider.id } })).toBe(1);
    expect(await ctx.prisma.promoCreditLot.count({ where: { providerId: provider.id } })).toBe(1);
    expect(await ctx.prisma.campaignRegistrationCounter.findFirstOrThrow({ where: { providerId: provider.id } })).toMatchObject({
      redemptionCount: 1,
    });
  });

  it('the provider panel route stays ownership-guarded: a staff account with PROVIDER_REVIEWS_READ is still refused there', async () => {
    const { provider } = await heldProvider();
    const as = await cookies();
    await request(ctx.server).get(`/providers/${provider.id}/reviews`).set('Cookie', as.reviewer).expect(403);
    await request(ctx.server).get(`/providers/${provider.id}/reviews`).set('Cookie', as.superAdmin).expect(200);
  });
});
