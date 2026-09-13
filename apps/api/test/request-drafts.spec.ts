import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCategory, createTestApp, createUser, loginAs, resetAuthThrottle, resetDatabase, type TestContext } from './harness';
import { RequestDraftsService } from '../src/modules/request-drafts/request-drafts.service';

/**
 * The server-side draft: what a browser can make it do, and what it cannot.
 *
 * The browser only ever holds an opaque token in an HttpOnly cookie. Everything
 * that decides who may open a draft — expectedUserId — is derived on the server
 * from the same identity classification the form saw, and is never sent or
 * returned.
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
  // This suite shares one app (and so one throttle bucket) across every case;
  // without this, the earlier cases would spend the draft-endpoint budget
  // before the dedicated throttling test gets to it. See resetAuthThrottle.
  resetAuthThrottle(ctx.app);
});

const COOKIE = 'taktic_request_draft';

const marketplace = {
  formType: 'MARKETPLACE',
  categorySlug: 'klima-servisi',
  payload: { city: 'İstanbul', district: 'Kadıköy', description: 'Klima bakımı', urgency: 'THIS_WEEK', answers: [] },
  identity: { phone: '05554440001', email: 'draft@example.test' },
};

const showcase = {
  formType: 'SHOWCASE_LEAD',
  categorySlug: 'klima-servisi',
  cardId: 'card-1',
  payload: { city: 'İstanbul', district: 'Kadıköy', description: 'Vitrin', urgencyBucket: 'URGENT', answers: [] },
  identity: { phone: '05554440001', email: 'draft@example.test' },
};

function post(body: Record<string, unknown>, cookie?: string, headers: Record<string, string> = {}) {
  const req = request(ctx.server).post('/request-drafts').set(headers);
  return cookie ? req.set('Cookie', `${COOKIE}=${cookie}`).send(body) : req.send(body);
}

function get(query: Record<string, string>, cookie?: string, session?: string) {
  const cookies = [cookie ? `${COOKIE}=${cookie}` : null, session ?? null].filter(Boolean).join('; ');
  const req = request(ctx.server).get('/request-drafts/current').query(query);
  return cookies ? req.set('Cookie', cookies) : req;
}

const mpQuery = { formType: 'MARKETPLACE', categorySlug: 'klima-servisi' };
const scQuery = { formType: 'SHOWCASE_LEAD', categorySlug: 'klima-servisi', cardId: 'card-1' };

describe('POST /request-drafts', () => {
  it('stores the payload under a hashed token and returns the raw token once', async () => {
    const response = await post(marketplace);

    expect(response.status).toBe(201);
    expect(typeof response.body.token).toBe('string');
    expect(response.body.token.length).toBeGreaterThan(30);
    expect(response.headers['set-cookie']).toBeUndefined();

    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(response.body.token);
    expect(row.expectedUserId).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.payload).toEqual(marketplace.payload);
    expect(JSON.stringify(row.payload)).not.toContain('05554440001');
    expect(JSON.stringify(row.payload)).not.toContain('draft@example.test');
  });

  it('refuses contact fields inside the payload', async () => {
    const response = await post({ ...marketplace, payload: { ...marketplace.payload, customerPhone: '05554440001' } });
    expect(response.status).toBe(400);
    expect(await ctx.prisma.requestDraft.count()).toBe(0);
  });

  it('refuses a payload over 32 KB', async () => {
    // Exceeds the 32 KB ceiling through `answers`, not through `description`'s
    // own @MaxLength(20_000) — this must fail on the service's byte-size
    // check, not incidentally pass DTO validation for the wrong reason.
    const answers = Array.from({ length: 100 }, (_, index) => ({ questionKey: `q${index}`, value: 'x'.repeat(400) }));
    const response = await post({ ...marketplace, payload: { ...marketplace.payload, answers } });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('DRAFT_TOO_LARGE');
  });

  it('sets expectedUserId from the identity check and never returns it', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });

    const response = await post(marketplace);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ token: expect.any(String), expiresAt: expect.any(String) });
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.expectedUserId).toBe(owner.id);
    expect(row.userId).toBeNull();
  });

  it('refuses to save a draft for a pair that cannot continue', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'a@example.test' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440002', email: 'draft@example.test' });

    const conflict = await post(marketplace);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('DRAFT_NOT_CONTINUABLE');

    await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05554440003', email: 'p@example.test' });
    const unavailable = await post({ ...marketplace, identity: { phone: '05554440003', email: 'new@example.test' } });
    expect(unavailable.status).toBe(409);
    expect(await ctx.prisma.requestDraft.count()).toBe(0);
  });

  it('updates the same draft in place for the same form context', async () => {
    const first = await post(marketplace);
    const second = await post({ ...marketplace, payload: { ...marketplace.payload, description: 'Güncel' } }, first.body.token);

    expect(second.status).toBe(201);
    expect(second.body.token).toBe(first.body.token);
    expect(await ctx.prisma.requestDraft.count()).toBe(1);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).payload).toMatchObject({ description: 'Güncel' });
  });

  it('keeps one active draft per browser: a different form needs an explicit replace', async () => {
    const first = await post(marketplace);
    const firstRow = await ctx.prisma.requestDraft.findFirstOrThrow();

    const refused = await post(showcase, first.body.token);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DRAFT_EXISTS');
    expect(await ctx.prisma.requestDraft.count()).toBe(1);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).tokenHash).toBe(firstRow.tokenHash);
    expect((await get(mpQuery, first.body.token)).status).toBe(200);

    const replaced = await post({ ...showcase, replace: true }, first.body.token);
    expect(replaced.status).toBe(201);
    expect(replaced.body.token).not.toBe(first.body.token);
    const rows = await ctx.prisma.requestDraft.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.formType).toBe('SHOWCASE_LEAD');
    expect((await get(mpQuery, first.body.token)).status).toBe(204);
    expect((await get(scQuery, replaced.body.token)).status).toBe(200);
  });

  it('is rate limited per client and a forged X-Forwarded-For does not help', async () => {
    let last = 0;
    for (let index = 0; index < 8; index += 1) {
      // A fresh browser every time (no cookie) so each call would be a new row.
      const response = await post(marketplace, undefined, { 'x-forwarded-for': `10.1.0.${index}` });
      last = response.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(await ctx.prisma.requestDraft.count()).toBeLessThanOrEqual(5);
  });

  it('answers 503 with Retry-After at the global ceiling, and writes nothing', async () => {
    const service = ctx.app.get(RequestDraftsService);
    const original = service.maxActive;
    service.maxActive = 1;
    try {
      const first = await request(ctx.server).post('/request-drafts').send(marketplace);
      expect(first.status).toBe(201);
      const second = await request(ctx.server).post('/request-drafts').send({ ...marketplace, identity: { phone: '05554440009', email: 'nine@example.test' } });
      expect(second.status).toBe(503);
      expect(second.body.code).toBe('DRAFT_STORAGE_BUSY');
      expect(second.headers['retry-after']).toBe('60');
      expect(await ctx.prisma.requestDraft.count()).toBe(1);
      // Updating the existing row is not a new row and passes the ceiling.
      const update = await post({ ...marketplace, payload: { ...marketplace.payload, description: 'Yine' } }, first.body.token);
      expect(update.status).toBe(201);
    } finally {
      service.maxActive = original;
    }
  });

  it('scopes AuthThrottlerGuard and RequestDraftThrottlerGuard to their own named budget', async () => {
    // Exhausting the draft budget must not spend a caller's login budget: a
    // browser drafting several forms can still sign in right after.
    for (let index = 0; index < 5; index += 1) {
      const response = await post({
        ...marketplace,
        identity: { phone: `0555500${String(index).padStart(4, '0')}`, email: `budget-${index}@example.test` },
      });
      expect(response.status).toBe(201);
    }
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: 'Password123!' });
    const loginAfterDraftBudget = await request(ctx.server)
      .post('/auth/login')
      .send({ email: user.email, password: 'WrongPassword!' });
    expect(loginAfterDraftBudget.status).toBe(401);
    // Discriminates the actual defect: without guard-level scoping, login
    // would also carry (and be checked against) the unrelated request-drafts
    // counter.
    expect(loginAfterDraftBudget.headers['x-ratelimit-limit-request-drafts']).toBeUndefined();
    expect(loginAfterDraftBudget.headers['x-ratelimit-limit-auth']).toBeDefined();

    resetAuthThrottle(ctx.app);

    // And the reverse: exhausting the login budget must not touch drafting.
    for (let index = 0; index < 5; index += 1) {
      const response = await request(ctx.server)
        .post('/auth/login')
        .send({ email: user.email, password: 'WrongPassword!' });
      expect(response.status).toBe(401);
    }
    const draftAfterLoginBudget = await post({
      ...marketplace,
      identity: { phone: '05559990000', email: 'after-login-budget@example.test' },
    });
    expect(draftAfterLoginBudget.status).toBe(201);
    expect(draftAfterLoginBudget.headers['x-ratelimit-limit-auth']).toBeUndefined();
    expect(draftAfterLoginBudget.headers['x-ratelimit-limit-request-drafts']).toBeDefined();
  });

  it('sweeps at most 200 expired rows, at most once an hour per process', async () => {
    const service = ctx.app.get(RequestDraftsService);
    // This suite shares one app across every case, and any earlier successful
    // create() has already kicked off its own opportunistic background sweep
    // (see request-drafts.service.ts) — which sets the hourly cooldown even
    // when it finds nothing expired to delete, by design (single-flight
    // against concurrent callers). Reset it here so this test observes a
    // clean cooldown rather than one a prior case already spent.
    (service as unknown as { lastSweepAt: number }).lastSweepAt = 0;
    const past = new Date(Date.now() - 60_000);
    await ctx.prisma.requestDraft.createMany({
      data: Array.from({ length: 250 }, (_, index) => ({
        tokenHash: `expired-${index}`,
        formType: 'MARKETPLACE' as const,
        categorySlug: 'x',
        payload: {},
        expiresAt: past,
      })),
    });

    expect(await service.sweepExpired()).toBe(200);
    expect(await ctx.prisma.requestDraft.count()).toBe(50);
    // Second call inside the hour is a no-op.
    expect(await service.sweepExpired()).toBe(0);
    expect(await ctx.prisma.requestDraft.count()).toBe(50);
  });
});

describe('GET /request-drafts/current', () => {
  it('opens an anonymous draft for its cookie bearer and binds it to nobody, even with a session', async () => {
    const someone = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await post(marketplace);

    const anon = await get(mpQuery, created.body.token);
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ payload: marketplace.payload });

    const withSession = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, someone.id));
    expect(withSession.status).toBe(200);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).userId).toBeNull();
  });

  it('keeps a protected draft closed without a session, and refuses the wrong account without deleting anything', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await post(marketplace);
    const before = await ctx.prisma.requestDraft.findFirstOrThrow();

    expect((await get(mpQuery, created.body.token)).status).toBe(204);

    const wrong = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, stranger.id));
    expect(wrong.status).toBe(200);
    expect(wrong.body).toEqual({ status: 'wrong-account' });

    const after = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(after.id).toBe(before.id);
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.expectedUserId).toBe(owner.id);
    expect(after.userId).toBeNull();
    expect(after.consumedAt).toBeNull();

    // The right account, on the same browser, afterwards: the very same draft.
    const right = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, owner.id));
    expect(right.status).toBe(200);
    expect(right.body).toEqual({ payload: marketplace.payload });
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).userId).toBe(owner.id);
  });

  it('answers 204 for another form context, an expired row, or a consumed row', async () => {
    const created = await post(marketplace);
    expect((await get(scQuery, created.body.token)).status).toBe(204);

    await ctx.prisma.requestDraft.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(mpQuery, created.body.token)).status).toBe(204);

    await ctx.prisma.requestDraft.updateMany({ data: { expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date() } });
    expect((await get(mpQuery, created.body.token)).status).toBe(204);
  });

  it('never leaks who is expected', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post(marketplace);
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const wrong = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, stranger.id));
    expect(JSON.stringify(wrong.body)).not.toMatch(/expectedUserId|userId|@example\.test/);
  });
});

describe('foreign keys', () => {
  it('deletes a protected draft with its expected user — it never becomes anonymous', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post(marketplace);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).expectedUserId).toBe(owner.id);

    await ctx.prisma.user.delete({ where: { id: owner.id } });

    expect(await ctx.prisma.requestDraft.count()).toBe(0);
    expect((await get(mpQuery, created.body.token)).status).toBe(204);
  });

  it('keeps the row and nulls userId when the bound user goes', async () => {
    const created = await post(marketplace);
    const someone = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await ctx.prisma.requestDraft.updateMany({ data: { userId: someone.id } });

    await ctx.prisma.user.delete({ where: { id: someone.id } });

    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.userId).toBeNull();
    expect(row.expectedUserId).toBeNull();
    expect((await get(mpQuery, created.body.token)).status).toBe(200);
  });
});

describe('DELETE /request-drafts/current', () => {
  it('removes the draft the cookie names and nothing else', async () => {
    const mine = await post(marketplace);
    const other = await request(ctx.server).post('/request-drafts').send({ ...marketplace, identity: { phone: '05554440008', email: 'eight@example.test' } });

    const response = await request(ctx.server).delete('/request-drafts/current').set('Cookie', `${COOKIE}=${mine.body.token}`);
    expect(response.status).toBe(204);
    expect(await ctx.prisma.requestDraft.count()).toBe(1);
    expect((await get(mpQuery, other.body.token)).status).toBe(200);
  });
});

/**
 * What actually submitting the request the draft was standing in for does to
 * the draft row itself. Consuming it is folded into the request's own
 * creation transaction (see `ServiceRequestsService.createServiceRequest` and
 * `RequestDraftsService.consumeInTransaction`), and never blocks the request:
 * a draft protected for another account is simply left alone.
 */
describe('consumption', () => {
  const guestBody = {
    categorySlug: '', // set per test
    customerName: 'Taslak Sahibi',
    customerPhone: '05554440001',
    customerEmail: 'draft@example.test',
    city: 'İstanbul',
    district: 'Kadıköy',
    description: 'Klima bakımı',
    answers: [],
  };

  async function leafCategory() {
    return createCategory(ctx.prisma, 'Klima Servisi', { offerCreditCost: 2 });
  }

  it('marks the anonymous draft consumed and bound to the customer the request created', async () => {
    const category = await leafCategory();
    const created = await post({ ...marketplace, categorySlug: category.slug });

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', `${COOKIE}=${created.body.token}`)
      .send({ ...guestBody, categorySlug: category.slug });

    expect(response.status).toBe(201);
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
    expect(row.userId).toBe(response.body.customerId);
    expect((await get({ formType: 'MARKETPLACE', categorySlug: category.slug }, created.body.token)).status).toBe(204);
  });

  it('leaves a draft protected for another account untouched and still creates the request', async () => {
    const category = await leafCategory();
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post({ ...marketplace, categorySlug: category.slug });

    // Somebody else submits from the same browser with their own contact.
    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', `${COOKIE}=${created.body.token}`)
      .send({ ...guestBody, categorySlug: category.slug, customerPhone: '05554440077', customerEmail: 'other@example.test' });

    expect(response.status).toBe(201);
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.consumedAt).toBeNull();
    expect(row.expectedUserId).toBe(owner.id);
  });

  it('consumes a protected draft when its expected customer submits', async () => {
    const category = await leafCategory();
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post({ ...marketplace, categorySlug: category.slug });

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', [`${COOKIE}=${created.body.token}`, await loginAs(ctx.prisma, owner.id)].join('; '))
      .send({ categorySlug: category.slug, city: 'İstanbul', district: 'Kadıköy', description: 'Klima', answers: [] });

    expect(response.status).toBe(201);
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
    expect(row.userId).toBe(owner.id);
  });
});
