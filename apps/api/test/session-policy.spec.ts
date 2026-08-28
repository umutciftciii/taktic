import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createUser,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The session policy, as the server enforces it.
 *
 * Two clocks end a session and neither extends the other: an inactivity window
 * that activity slides, and an absolute lifetime that nothing does. "Beni
 * hatırla" selects a different pair of durations for both — it is a policy, not
 * a longer cookie — and `Session.rememberMe` is what the server reads to decide
 * which pair a given session runs under.
 *
 * The pair of cases that matter most are the crossed ones: an ordinary session
 * must never be granted the remembered window, and a remembered one must never
 * be measured against the ordinary one. Everything else here is a clock.
 *
 * Every case drives the real endpoints and then reads or rewrites the `Session`
 * row directly to move time. That is deliberate: waiting thirty real minutes is
 * not a test — and waiting thirty days is not a suite — while a fake timer would
 * only prove that this process believes its own clock. Rewriting `lastSeenAt`
 * reproduces exactly the state a genuinely idle session is in, and the decision
 * under test is then made by the production code path against the database.
 */

let ctx: TestContext;

const PASSWORD = 'Password123!';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  restoreDefaults();
});

afterEach(() => {
  restoreDefaults();
});

function restoreDefaults() {
  delete process.env.SESSION_IDLE_TIMEOUT_SECONDS;
  delete process.env.SESSION_ABSOLUTE_TTL_SECONDS;
  delete process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS;
  delete process.env.SESSION_REMEMBER_ME_TTL_SECONDS;
  delete process.env.SESSION_TOUCH_INTERVAL_SECONDS;
  delete process.env.SESSION_IDLE_WARNING_SECONDS;
  delete process.env.SESSION_REMEMBER_ME_IDLE_WARNING_SECONDS;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function createLoginUser(role: UserRole = UserRole.CUSTOMER) {
  return createUser(ctx.prisma, { role, password: PASSWORD });
}

/** Signs in through the real endpoint and returns the cookie it set. */
async function login(email: string, body: Record<string, unknown> = {}) {
  const response = await request(ctx.server)
    .post('/auth/login')
    .send({ email, password: PASSWORD, ...body })
    .expect(201);

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw, 'login must set a session cookie').toBeTruthy();

  const value = String(raw);
  const sessionId = decodeURIComponent(value.split(';')[0]!.split('=').slice(1).join('='));

  return { cookie: `taktic_session=${sessionId}`, sessionId, setCookie: value };
}

/** Moves a session's activity mark into the past, as real inactivity would. */
function ageSession(sessionId: string, seconds: number) {
  return ctx.prisma.session.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date(Date.now() - seconds * 1000) },
  });
}

describe('session cookie', () => {
  it('is HttpOnly, SameSite=Lax, path-scoped and non-persistent without "remember me"', async () => {
    const user = await createLoginUser();
    const { setCookie } = await login(user.email!);

    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    // No Max-Age and no Expires: the browser drops it when it closes. The
    // server-side row is what actually keeps the session alive, so this costs
    // nothing and means an unremembered session does not outlive the browser.
    expect(setCookie).not.toContain('Max-Age');
    expect(setCookie).not.toContain('Expires');
    // NODE_ENV is "test" here, which is exactly why Secure is absent: the suite
    // and the local stack speak plain HTTP, and a Secure cookie would simply be
    // dropped. Production sets it — see cookie.ts.
    expect(setCookie).not.toContain('Secure');
  });

  it('becomes persistent, and lasts the remember-me lifetime, when asked', async () => {
    process.env.SESSION_REMEMBER_ME_TTL_SECONDS = String(30 * 24 * 60 * 60);
    const user = await createLoginUser();
    const { setCookie, sessionId } = await login(user.email!, { rememberMe: true });

    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=');
    expect(setCookie).toContain('Expires=');

    const session = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.rememberMe).toBe(true);

    const lifetimeSeconds = (session.expiresAt.getTime() - session.createdAt.getTime()) / 1000;
    expect(lifetimeSeconds).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(lifetimeSeconds).toBeLessThanOrEqual(30 * 24 * 60 * 60 + 5);
  });

  it('accepts the string a form posts, not only a JSON boolean', async () => {
    const user = await createLoginUser();
    const { sessionId } = await login(user.email!, { rememberMe: 'true' });

    const session = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.rememberMe).toBe(true);
  });

  it('defaults to an ordinary, shorter session when nothing is said', async () => {
    process.env.SESSION_ABSOLUTE_TTL_SECONDS = String(8 * 60 * 60);
    const user = await createLoginUser();
    const { sessionId } = await login(user.email!);

    const session = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.rememberMe).toBe(false);

    const lifetimeSeconds = (session.expiresAt.getTime() - session.createdAt.getTime()) / 1000;
    expect(lifetimeSeconds).toBeLessThanOrEqual(8 * 60 * 60 + 5);
  });
});

describe('idle timeout', () => {
  it('refuses a session whose last activity is older than the window', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = '1800';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);

    // Twenty-nine minutes of silence is still inside the window.
    await ageSession(sessionId, 29 * 60);
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);

    // Thirty-one is not, and the session row is untouched — nothing was
    // revoked, it simply stopped being usable.
    await ageSession(sessionId, 31 * 60);
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);

    const session = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).toBeNull();
  });

  it('does not apply the ordinary window to a remembered session', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = String(30 * MINUTE);
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);

    const ordinary = await createLoginUser();
    const remembered = await createLoginUser();
    const plain = await login(ordinary.email!);
    const kept = await login(remembered.email!, { rememberMe: true });

    // The same silence, the same moment, two different answers — and the only
    // thing that differs between the two rows is `rememberMe`. This is the
    // whole point of the feature: without it, the box changed nothing anybody
    // would notice after half an hour.
    await ageSession(plain.sessionId, 31 * MINUTE);
    await ageSession(kept.sessionId, 31 * MINUTE);

    await request(ctx.server).get('/auth/me').set('Cookie', plain.cookie).expect(401);
    await request(ctx.server).get('/auth/me').set('Cookie', kept.cookie).expect(200);
  });

  it('ends a remembered session at its own, longer window', async () => {
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!, { rememberMe: true });

    // Twenty-nine days of silence is still inside it.
    await ageSession(sessionId, 29 * DAY);
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);

    // Thirty-one is not. A remembered session is a longer promise, not an
    // unlimited one.
    await ageSession(sessionId, 31 * DAY);
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
  });

  it('does not give an ordinary session the remembered window', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = String(30 * MINUTE);
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);

    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    // The mirror of the case above: the longer window must not leak the other
    // way either, however the row is read.
    await ageSession(sessionId, 31 * MINUTE);
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
  });

  it('slides on real activity, and only past the touch interval', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = '1800';
    process.env.SESSION_TOUCH_INTERVAL_SECONDS = '300';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    // Inside the touch interval: the request is served and the row is left
    // alone, which is what keeps an active session off the write path.
    await ageSession(sessionId, 60);
    const before = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    const unchanged = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(unchanged.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());

    // Past it: the mark moves, and the idle window starts again from now.
    await ageSession(sessionId, 20 * 60);
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    const touched = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(Date.now() - touched.lastSeenAt.getTime()).toBeLessThan(5_000);
  });
});

describe('absolute lifetime', () => {
  it('is never extended by activity', async () => {
    process.env.SESSION_ABSOLUTE_TTL_SECONDS = '3600';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    const issued = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

    // Several requests, each of them activity, each of them past the touch
    // interval.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ageSession(sessionId, 10 * 60);
      await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    }

    const later = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(later.expiresAt.getTime()).toBe(issued.expiresAt.getTime());
  });

  it('ends the session even when it is being used constantly', async () => {
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    // The absolute expiry brought forward, with activity as recent as it gets:
    // the state a session that has simply been alive too long is in.
    await ctx.prisma.session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1000), lastSeenAt: new Date() },
    });

    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
  });

  it('ends a remembered session too, however recently it was used', async () => {
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!, { rememberMe: true });

    // Its idle window is nowhere near spent — activity is as recent as it gets
    // — and the session is over anyway. A longer idle window is not a way
    // around the absolute one.
    await ctx.prisma.session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1000), lastSeenAt: new Date() },
    });

    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
  });

  it('cannot be pushed forward by touching the session', async () => {
    process.env.SESSION_ABSOLUTE_TTL_SECONDS = '3600';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);
    const issued = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(ctx.server).post('/auth/session/touch').set('Cookie', cookie).expect(201);
    }

    const later = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(later.expiresAt.getTime()).toBe(issued.expiresAt.getTime());
  });
});

describe('GET /auth/session', () => {
  it('reports both clocks and the server time, and does not spend the idle window', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = '1800';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    await ageSession(sessionId, 25 * 60);
    const before = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

    const response = await request(ctx.server)
      .get('/auth/session')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.rememberMe).toBe(false);
    expect(response.body.idleTimeoutSeconds).toBe(1800);
    expect(response.body.idleWarningSeconds).toBe(120);
    expect(typeof response.body.serverTime).toBe('string');

    // The idle expiry is five minutes out — 25 of the 30 are gone.
    const idleExpiresAt = Date.parse(response.body.idleExpiresAt);
    const remaining = (idleExpiresAt - Date.parse(response.body.serverTime)) / 1000;
    expect(remaining).toBeGreaterThan(4 * 60);
    expect(remaining).toBeLessThan(6 * 60);

    // And reading it changed nothing. This is the property that makes an idle
    // warning possible at all: a polling tab must not be able to keep an
    // unattended browser signed in forever.
    const after = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
  });

  it('reports the remembered policy for a remembered session', async () => {
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);
    process.env.SESSION_REMEMBER_ME_IDLE_WARNING_SECONDS = String(DAY);

    const user = await createLoginUser();
    const { cookie } = await login(user.email!, { rememberMe: true });

    const response = await request(ctx.server)
      .get('/auth/session')
      .set('Cookie', cookie)
      .expect(200);

    // The window this session is actually running under, not the deployment's
    // ordinary one. A client told 30 minutes here would warn — and give up —
    // at entirely the wrong moment.
    expect(response.body.rememberMe).toBe(true);
    expect(response.body.idleTimeoutSeconds).toBe(30 * DAY);
    expect(response.body.idleWarningSeconds).toBe(DAY);

    const remaining =
      (Date.parse(response.body.idleExpiresAt) - Date.parse(response.body.serverTime)) / 1000;
    expect(remaining).toBeGreaterThan(29 * DAY);
  });

  it('clamps a warning that is longer than the window it belongs to', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = String(10 * MINUTE);
    // A warning longer than the whole window would be on screen from the moment
    // of login, which is not a warning.
    process.env.SESSION_IDLE_WARNING_SECONDS = String(HOUR);

    const user = await createLoginUser();
    const { cookie } = await login(user.email!);

    const response = await request(ctx.server)
      .get('/auth/session')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.idleWarningSeconds).toBe(10 * MINUTE);
  });

  it('is 401 for an idle-expired session, so a polling client learns it is over', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = '1800';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    await ageSession(sessionId, 31 * 60);
    await request(ctx.server).get('/auth/session').set('Cookie', cookie).expect(401);
  });

  it('is 401 without a cookie at all', async () => {
    await request(ctx.server).get('/auth/session').expect(401);
  });
});

describe('POST /auth/session/touch', () => {
  it('extends the idle window on demand, regardless of the touch interval', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = '1800';
    process.env.SESSION_TOUCH_INTERVAL_SECONDS = '300';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    // Well inside the touch interval, where an ordinary request would leave the
    // mark alone. An explicit "keep me signed in" must not be throttled — the
    // whole point of the click is to move it now.
    await ageSession(sessionId, 30);
    await request(ctx.server).post('/auth/session/touch').set('Cookie', cookie).expect(201);

    const session = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(Date.now() - session.lastSeenAt.getTime()).toBeLessThan(5_000);
  });

  it('slides a remembered session\'s window without extending its lifetime', async () => {
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!, { rememberMe: true });
    const issued = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

    await ageSession(sessionId, 10 * DAY);
    await request(ctx.server).post('/auth/session/touch').set('Cookie', cookie).expect(201);

    const touched = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(Date.now() - touched.lastSeenAt.getTime()).toBeLessThan(5_000);
    expect(touched.expiresAt.getTime()).toBe(issued.expiresAt.getTime());
  });

  it('cannot revive a session the idle window already ended', async () => {
    process.env.SESSION_IDLE_TIMEOUT_SECONDS = '1800';
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    await ageSession(sessionId, 31 * 60);
    await request(ctx.server).post('/auth/session/touch').set('Cookie', cookie).expect(401);
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
  });
});

describe('revocation', () => {
  it('logout revokes the session on the server, not only in the browser', async () => {
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!);

    await request(ctx.server).post('/auth/logout').set('Cookie', cookie).expect(201);

    const session = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).not.toBeNull();

    // The cookie still exists and is worthless — which is what makes "log out
    // in one tab" safe for every other tab holding the same cookie.
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
    await request(ctx.server).get('/auth/session').set('Cookie', cookie).expect(401);
  });

  it('logout ends a remembered session as immediately as any other', async () => {
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!, { rememberMe: true });

    await request(ctx.server).post('/auth/logout').set('Cookie', cookie).expect(201);

    // A month of idle window and a month of absolute life, both irrelevant: a
    // revoked session is refused before either clock is consulted.
    const session = await ctx.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).not.toBeNull();
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
    await request(ctx.server).get('/auth/session').set('Cookie', cookie).expect(401);
  });

  it('a server-side revoke ends a remembered session with no client involved', async () => {
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = String(30 * DAY);
    const user = await createLoginUser();
    const { cookie, sessionId } = await login(user.email!, { rememberMe: true });

    // What "log out everywhere", a password reset and a deactivation all do.
    await ctx.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(401);
    await request(ctx.server).post('/auth/session/touch').set('Cookie', cookie).expect(401);
  });

  it('logging in revokes the session the browser arrived with', async () => {
    const user = await createLoginUser();
    const first = await login(user.email!);

    // The same browser signs in again while still holding the earlier cookie.
    // This is the session-fixation case: a cookie planted before authentication
    // must not survive it.
    const second = await request(ctx.server)
      .post('/auth/login')
      .set('Cookie', first.cookie)
      .send({ email: user.email, password: PASSWORD })
      .expect(201);

    expect(second.headers['set-cookie']).toBeTruthy();

    const revoked = await ctx.prisma.session.findUniqueOrThrow({ where: { id: first.sessionId } });
    expect(revoked.revokedAt).not.toBeNull();
    await request(ctx.server).get('/auth/me').set('Cookie', first.cookie).expect(401);
  });
});

describe('policy configuration', () => {
  it('refuses a duration that is not a positive whole number of seconds', async () => {
    const user = await createLoginUser();
    const { cookie } = await login(user.email!);

    process.env.SESSION_IDLE_TIMEOUT_SECONDS = '0';
    // Read per call, so the bad value is seen immediately — and it fails loudly
    // rather than silently restoring a default nobody chose. A 500 here is the
    // in-process shape of what `assertSessionPolicyConfig` turns into a refusal
    // to boot.
    await request(ctx.server).get('/auth/session').set('Cookie', cookie).expect(500);
  });

  it('refuses a bad remembered duration too, on the session it belongs to', async () => {
    const user = await createLoginUser();
    const { cookie } = await login(user.email!, { rememberMe: true });

    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = 'yarım saat';
    await request(ctx.server).get('/auth/session').set('Cookie', cookie).expect(500);
  });

  it('leaves an ordinary session alone when only the remembered policy is broken', async () => {
    const user = await createLoginUser();
    const { cookie } = await login(user.email!);

    // The two policies are read independently, so a typo in one is not an
    // outage for people running under the other. (At boot the assertion checks
    // both, so this state does not survive a restart.)
    process.env.SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS = '-1';
    await request(ctx.server).get('/auth/session').set('Cookie', cookie).expect(200);
  });
});
