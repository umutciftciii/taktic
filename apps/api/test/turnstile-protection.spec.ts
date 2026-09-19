import { CustomerOrigin, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CloudflareTurnstileVerifier } from '../src/modules/turnstile/cloudflare-turnstile.verifier';
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
  type TurnstileAction,
} from '../src/modules/turnstile/turnstile.constants';
import { REQUEST_DRAFT_COOKIE_NAME } from '../src/modules/request-drafts/request-drafts.constants';
import { SERVICE_REQUEST_THROTTLE_LIMIT } from '../src/modules/service-requests/service-requests.constants';
import { AUTH_THROTTLE_LIMIT } from '../src/modules/auth/auth.throttler';
import {
  createApprovedRequest,
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  loginAs,
  proveShowcaseLeadPhone,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  showcaseLeadPayload,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * The Turnstile guard on the seven protected write routes, driven
 * through real HTTP against the real Cloudflare verifier — with Cloudflare
 * itself stood in for by a fetch stub that answers according to the token it
 * is shown. Every refusal is asserted twice: on the status and code the
 * client sees, and on the database, the SMS recorder and the mail recorder
 * all being exactly as they were. A refused request must cost nothing.
 *
 * The stub is a tiny fake Cloudflare: a token is `tok:<verdict>:<nonce>`,
 * where the verdict names what siteverify would have said about it. It never
 * inspects the request beyond the `response` field, so the guard's own
 * behaviour — header reading, replay cache, error mapping, guard order — is
 * what these cases exercise.
 */

const HOSTNAME = 'taktick.example';
const TIMEOUT_MS = 200;

type Verdict =
  | { kind: 'ok'; action: TurnstileAction; hostname?: string }
  | { kind: 'fail' }
  | { kind: 'timeout' }
  | { kind: '5xx' }
  | { kind: 'garbage' };

const minted = new Map<string, Verdict>();

function mint(verdict: Verdict): string {
  const token = `tok:${verdict.kind}:${uniqueSuffix()}:${minted.size}`;
  minted.set(token, verdict);
  return token;
}

/** A token Cloudflare would accept for this operation on this deployment. */
function good(action: TurnstileAction): string {
  return mint({ kind: 'ok', action });
}

const fakeCloudflare: typeof fetch = async (_input, init) => {
  const token = new URLSearchParams(String(init?.body)).get('response') ?? '';
  const verdict = minted.get(token) ?? { kind: 'fail' as const };
  switch (verdict.kind) {
    case 'ok':
      return new Response(
        JSON.stringify({
          success: true,
          challenge_ts: new Date().toISOString(),
          hostname: verdict.hostname ?? HOSTNAME,
          'error-codes': [],
          action: verdict.action,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'fail':
      return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    case 'timeout':
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    case '5xx':
      return new Response('bad gateway', { status: 502 });
    case 'garbage':
      return new Response('<html>not json</html>', { status: 200 });
  }
};

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp({
    turnstileVerifier: new CloudflareTurnstileVerifier(
      {
        mode: 'cloudflare',
        secretKey: 'not-a-real-secret',
        expectedHostnames: new Set([HOSTNAME]),
        siteverifyTimeoutMs: TIMEOUT_MS,
      },
      fakeCloudflare,
    ),
  });
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  ctx.sms.clear();
  ctx.notifications.clear();
});

/** Everything a refused request must leave untouched. */
async function sideEffects() {
  return {
    serviceRequests: await ctx.prisma.serviceRequest.count(),
    showcaseLeads: await ctx.prisma.showcaseLead.count(),
    phoneVerifications: await ctx.prisma.phoneVerification.count(),
    notificationLogs: await ctx.prisma.notificationLog.count(),
    activationTokens: await ctx.prisma.customerActivationToken.count(),
    consumedDrafts: await ctx.prisma.requestDraft.count({ where: { consumedAt: { not: null } } }),
    users: await ctx.prisma.user.count(),
    smsSent: ctx.sms.sent.length,
    mailsSent: ctx.notifications.sent.length,
  };
}

type Route = {
  name: string;
  action: TurnstileAction;
  /** Seeds whatever the happy path needs and returns a sender. */
  prepare: () => Promise<(token: string | null) => request.Test>;
  /** The status the route answered with before Turnstile existed. */
  okStatus: number;
  /** What the happy path must have produced — the proof the route still works. */
  expectDone: (before: Awaited<ReturnType<typeof sideEffects>>) => Promise<void>;
};

function withToken(req: request.Test, token: string | null): request.Test {
  return token === null ? req : req.set(TURNSTILE_TOKEN_HEADER, token);
}

const ROUTES: Route[] = [
  {
    name: 'POST /service-requests',
    action: TURNSTILE_ACTIONS.serviceRequestCreate,
    okStatus: 201,
    prepare: async () => {
      const category = await createCategory(ctx.prisma);
      return (token) =>
        withToken(request(ctx.server).post('/service-requests'), token).send(serviceRequestPayload(category.slug));
    },
    expectDone: async (before) => {
      expect(await ctx.prisma.serviceRequest.count()).toBe(before.serviceRequests + 1);
    },
  },
  {
    name: 'POST /showcase/cards/:cardId/leads',
    action: TURNSTILE_ACTIONS.showcaseLeadCreate,
    okStatus: 201,
    prepare: async () => {
      const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
      const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
      const owner = await createDiscoverableProvider(ctx.prisma, {
        userId: ownerUser.id,
        categoryId: category.id,
        areas: [{ city: 'İstanbul', district: null }],
      });
      const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
        providerId: owner.id,
        categoryId: category.id,
      });
      const pkg = await createShowcasePackage(ctx.prisma);
      await createLiveShowcasePlacement(ctx, {
        providerId: owner.id,
        cardId: card.id,
        versionId: version.id,
        packageId: pkg.id,
      });
      const payload = showcaseLeadPayload(category.slug);
      await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
      return (token) =>
        withToken(request(ctx.server).post(`/showcase/cards/${card.id}/leads`), token).send(payload);
    },
    expectDone: async (before) => {
      expect(await ctx.prisma.showcaseLead.count()).toBe(before.showcaseLeads + 1);
    },
  },
  {
    name: 'POST /showcase/lead-verification',
    action: TURNSTILE_ACTIONS.phoneCodeSend,
    okStatus: 200,
    prepare: async () => (token) =>
      withToken(request(ctx.server).post('/showcase/lead-verification'), token).send({
        phone: `0555888${uniqueSuffix().padStart(4, '0')}`,
      }),
    expectDone: async (before) => {
      expect(ctx.sms.sent.length).toBe(before.smsSent + 1);
    },
  },
  {
    name: 'POST /service-requests/:id/phone-verification',
    action: TURNSTILE_ACTIONS.phoneCodeSend,
    okStatus: 201,
    prepare: async () => {
      const category = await createCategory(ctx.prisma);
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
      const serviceRequest = await createApprovedRequest(ctx.prisma, {
        categoryId: category.id,
        customerId: customer.id,
      });
      const cookie = await loginAs(ctx.prisma, customer.id);
      return (token) =>
        withToken(
          request(ctx.server).post(`/service-requests/${serviceRequest.id}/phone-verification`).set('Cookie', cookie),
          token,
        );
    },
    expectDone: async (before) => {
      expect(ctx.sms.sent.length).toBe(before.smsSent + 1);
    },
  },
  {
    name: 'POST /providers/me/phone-verification',
    action: TURNSTILE_ACTIONS.phoneCodeSend,
    okStatus: 201,
    prepare: async () => {
      // The provider's own account number (AUTH-PROVIDER-CONTACT-001): the
      // same gate as the request send, ahead of the session.
      const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
      const cookie = await loginAs(ctx.prisma, provider.id);
      return (token) =>
        withToken(request(ctx.server).post('/providers/me/phone-verification').set('Cookie', cookie), token);
    },
    expectDone: async (before) => {
      expect(ctx.sms.sent.length).toBe(before.smsSent + 1);
    },
  },
  {
    name: 'POST /auth/request-identity-check',
    action: TURNSTILE_ACTIONS.identityCheck,
    okStatus: 200,
    prepare: async () => (token) =>
      withToken(request(ctx.server).post('/auth/request-identity-check'), token).send({
        phone: `0555999${uniqueSuffix().padStart(4, '0')}`,
        email: `fresh-${uniqueSuffix()}@example.test`,
      }),
    expectDone: async () => {
      // A read: the proof is the 200 itself.
    },
  },
  {
    name: 'POST /auth/request-identity-check/activate',
    action: TURNSTILE_ACTIONS.identityActivate,
    okStatus: 202,
    prepare: async () => {
      const phone = `0555666${uniqueSuffix().padStart(4, '0')}`;
      const email = `claim-${uniqueSuffix()}@example.test`;
      await createUser(ctx.prisma, {
        role: UserRole.CUSTOMER,
        phone,
        email,
        password: null,
        customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
      });
      return (token) =>
        withToken(request(ctx.server).post('/auth/request-identity-check/activate'), token).send({ phone, email });
    },
    expectDone: async (before) => {
      expect(ctx.notifications.ofTemplate('customer-activation')).toHaveLength(1);
      expect(await ctx.prisma.customerActivationToken.count()).toBe(before.activationTokens + 1);
    },
  },
];

describe.each(ROUTES)('$name', (route) => {
  it('does what it always did with a token Cloudflare accepts for this operation', async () => {
    const send = await route.prepare();
    const before = await sideEffects();

    const response = await send(good(route.action));

    expect(response.status).toBe(route.okStatus);
    await route.expectDone(before);
  });

  it('answers 403 TURNSTILE_REQUIRED without a header, and changes nothing', async () => {
    const send = await route.prepare();
    const before = await sideEffects();

    const response = await send(null);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_REQUIRED');
    expect(await sideEffects()).toEqual(before);
  });

  it('answers 403 TURNSTILE_FAILED for a token Cloudflare refuses, and changes nothing', async () => {
    const send = await route.prepare();
    const before = await sideEffects();

    const response = await send(mint({ kind: 'fail' }));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_FAILED');
    expect(await sideEffects()).toEqual(before);
  });

  it('answers 403 TURNSTILE_FAILED for a token minted for another operation', async () => {
    const send = await route.prepare();
    const before = await sideEffects();
    const otherAction =
      route.action === TURNSTILE_ACTIONS.identityCheck
        ? TURNSTILE_ACTIONS.serviceRequestCreate
        : TURNSTILE_ACTIONS.identityCheck;

    const response = await send(good(otherAction));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_FAILED');
    expect(await sideEffects()).toEqual(before);
  });

  it('answers 403 TURNSTILE_FAILED for a token solved on another hostname', async () => {
    const send = await route.prepare();
    const before = await sideEffects();

    const response = await send(mint({ kind: 'ok', action: route.action, hostname: 'evil.example' }));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_FAILED');
    expect(await sideEffects()).toEqual(before);
  });

  it('refuses the same token a second time', async () => {
    const send = await route.prepare();
    const token = good(route.action);

    expect((await send(token)).status).toBe(route.okStatus);
    const again = await route.prepare();
    const before = await sideEffects();

    const response = await again(token);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_FAILED');
    expect(await sideEffects()).toEqual(before);
  });

  it.each([
    ['times out', { kind: 'timeout' } as const],
    ['answers 5xx', { kind: '5xx' } as const],
    ['answers something that is not JSON', { kind: 'garbage' } as const],
  ])('answers 503 TURNSTILE_UNAVAILABLE when siteverify %s, and changes nothing', async (_label, verdict) => {
    const send = await route.prepare();
    const before = await sideEffects();

    const response = await send(mint(verdict));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('TURNSTILE_UNAVAILABLE');
    expect(await sideEffects()).toEqual(before);
  });

  it('never echoes the token in a refusal', async () => {
    const send = await route.prepare();
    const token = mint({ kind: 'fail' });
    const response = await send(token);
    expect(JSON.stringify(response.body)).not.toContain(token);
  });
});

/** A route by name, for the cross-route cases below. */
function route(name: string): Route {
  const found = ROUTES.find((entry) => entry.name === name);
  if (!found) throw new Error(`no route ${name}`);
  return found;
}

describe('a token is bound to one operation and one use', () => {
  it('is refused on a second route even when the first use was refused', async () => {
    const check = await route('POST /auth/request-identity-check').prepare();
    const create = await route('POST /service-requests').prepare();
    // Minted for the request, shown first to the identity check (a mismatch,
    // refused) and then to the request it was minted for: still refused,
    // because it was claimed on first sight.
    const token = good(TURNSTILE_ACTIONS.serviceRequestCreate);

    expect((await check(token)).status).toBe(403);
    const response = await create(token);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_FAILED');
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('is refused on a second route after a successful first use', async () => {
    const check = await route('POST /auth/request-identity-check').prepare();
    const token = good(TURNSTILE_ACTIONS.identityCheck);

    expect((await check(token)).status).toBe(200);
    const again = await route('POST /auth/request-identity-check').prepare();
    expect((await again(token)).status).toBe(403);
  });
});

describe('what the guard leaves in place', () => {
  it('leaves a parked draft unconsumed when the request behind it is refused', async () => {
    const category = await createCategory(ctx.prisma);
    const parked = await request(ctx.server)
      .post('/request-drafts')
      .send({
        formType: 'MARKETPLACE',
        categorySlug: category.slug,
        payload: { city: 'İstanbul', district: 'Kadıköy', description: 'Taslak', answers: [] },
        identity: { phone: '05554440001', email: 'draft@example.test' },
      });
    expect(parked.status).toBe(201);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', `${REQUEST_DRAFT_COOKIE_NAME}=${parked.body.token}`)
      .send(serviceRequestPayload(category.slug, { customerPhone: '05554440001', customerEmail: 'draft@example.test' }));

    expect(response.status).toBe(403);
    const draft = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(draft.consumedAt).toBeNull();
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('keeps the IP throttle on POST /service-requests: valid tokens do not buy more than the budget', async () => {
    const category = await createCategory(ctx.prisma);
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= SERVICE_REQUEST_THROTTLE_LIMIT; attempt += 1) {
      const response = await request(ctx.server)
        .post('/service-requests')
        .set(TURNSTILE_TOKEN_HEADER, good(TURNSTILE_ACTIONS.serviceRequestCreate))
        .send(serviceRequestPayload(category.slug, { customerPhone: `05551110${String(attempt).padStart(3, '0')}` }));
      statuses.push(response.status);
    }
    expect(statuses.slice(0, SERVICE_REQUEST_THROTTLE_LIMIT).every((status) => status === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('keeps the credential throttle on the identity check, ahead of the Turnstile guard', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= AUTH_THROTTLE_LIMIT; attempt += 1) {
      const response = await request(ctx.server)
        .post('/auth/request-identity-check')
        .send({ phone: '05551110001', email: 'fresh@example.test' });
      statuses.push(response.status);
    }
    // Every call inside the budget is refused by Turnstile (no header); the
    // one past it is refused by the throttle, which runs first.
    expect(statuses.slice(0, AUTH_THROTTLE_LIMIT).every((status) => status === 403)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('keeps the existing refusals behind a valid token (a provider session may not open a request)', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, providerUser.id);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .set(TURNSTILE_TOKEN_HEADER, good(TURNSTILE_ACTIONS.serviceRequestCreate))
      .send(serviceRequestPayload(category.slug));

    expect(response.status).toBe(403);
    expect(response.body.code).toBeUndefined();
  });
});
