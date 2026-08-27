import { NotificationStatus, ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertProviderClaimConfig,
  isProviderClaimEnabled,
  PROVIDER_CLAIM_TOKEN_TTL_HOURS,
} from '../src/modules/provider-claim/provider-claim.config';
import { ProviderClaimRateLimiter } from '../src/modules/provider-claim/provider-claim.rate-limiter';
import { notificationOutboxDir } from '../src/modules/notifications/notification-outbox';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  providerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

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
  // The per-address budget lives in memory for the life of this Nest app, so a
  // case that deliberately exhausts it would otherwise poison every later one.
  ctx.app.get(ProviderClaimRateLimiter).reset();
  delete process.env.PROVIDER_CLAIM_ENABLED;
});

afterEach(() => {
  delete process.env.PROVIDER_CLAIM_ENABLED;
});

function enableClaim() {
  process.env.PROVIDER_CLAIM_ENABLED = 'true';
}

const APPLICANT_EMAIL = 'esnaf@example.test';

/**
 * Submits a guest application through the real endpoint and hands back the raw
 * claim token the way an applicant gets it: out of the message, never out of the
 * HTTP response.
 */
async function submitGuestApplication(
  email: string = APPLICANT_EMAIL,
  overrides: Record<string, unknown> = {},
) {
  const category = await createCategory(ctx.prisma);
  const response = await request(ctx.server)
    .post('/providers')
    .send({ ...providerPayload([category.id]), email, ...overrides })
    .expect(201);

  return { providerId: response.body.id as string, response };
}

function lastClaimToken(): string {
  const message = ctx.notifications.lastOfTemplate('provider-claim');
  if (!message?.actionUrl) {
    throw new Error('no claim invitation was sent');
  }

  return new URL(message.actionUrl).searchParams.get('token') as string;
}

/** The session cookie the API just issued, in `name=value` form. */
function sessionCookieFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  if (!first) {
    throw new Error('no session cookie was issued');
  }

  return first.split(';')[0] as string;
}

async function issuedTokenCount(providerId: string) {
  return ctx.prisma.providerClaimToken.count({ where: { providerId } });
}

describe('POST /providers — flag off keeps today’s guest application behaviour', () => {
  it('accepts a guest application with no e-mail at all and sends nothing', async () => {
    const category = await createCategory(ctx.prisma);

    const response = await request(ctx.server)
      .post('/providers')
      .send(providerPayload([category.id]))
      .expect(201);

    const stored = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: response.body.id },
    });

    expect(stored.userId).toBeNull();
    expect(stored.email).toBeNull();
    expect(stored.claimedAt).toBeNull();
    expect(await issuedTokenCount(stored.id)).toBe(0);
    expect(ctx.notifications.ofTemplate('provider-claim')).toHaveLength(0);
  });

  it('refuses both claim endpoints while the flag is off', async () => {
    const validate = await request(ctx.server).get('/auth/provider-claim?token=anything');
    expect(validate.status).toBe(409);
    expect(validate.body.code).toBe('PROVIDER_CLAIM_DISABLED');

    const submit = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token: 'anything', password: 'Password123!' });
    expect(submit.status).toBe(409);
    expect(submit.body.code).toBe('PROVIDER_CLAIM_DISABLED');
  });

  it('refuses the admin invitation endpoint while the flag is off', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const provider = await createProviderProfile(ctx.prisma, { userId: null });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/claim-invitations`)
      .set('Cookie', cookie);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROVIDER_CLAIM_DISABLED');
    expect(await issuedTokenCount(provider.id)).toBe(0);
  });
});

describe('POST /providers — flag on requires a reachable guest application', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('refuses a guest application with no e-mail', async () => {
    const category = await createCategory(ctx.prisma);

    const response = await request(ctx.server)
      .post('/providers')
      .send(providerPayload([category.id]));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PROVIDER_EMAIL_REQUIRED');
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses a guest application whose e-mail is not an address', async () => {
    const category = await createCategory(ctx.prisma);

    const response = await request(ctx.server)
      .post('/providers')
      .send({ ...providerPayload([category.id]), email: 'not-an-address' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PROVIDER_EMAIL_REQUIRED');
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('folds the stored address to lower case', async () => {
    const { providerId } = await submitGuestApplication('Esnaf@Example.TEST');

    const stored = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(stored.email).toBe('esnaf@example.test');

    const token = await ctx.prisma.providerClaimToken.findFirstOrThrow({
      where: { providerId },
    });
    expect(token.emailSnapshot).toBe('esnaf@example.test');
  });

  it('leaves an application made by a signed-in provider alone', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const category = await createCategory(ctx.prisma);

    // No e-mail, and that stays acceptable: this application is already owned,
    // so nothing about it ever needs to be claimed.
    const response = await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send(providerPayload([category.id]))
      .expect(201);

    const stored = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.userId).toBe(owner.id);
    expect(stored.claimedAt).toBeNull();
    expect(await issuedTokenCount(stored.id)).toBe(0);
  });

  it('still refuses a customer outright', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), email: APPLICANT_EMAIL })
      .expect(403);
  });
});

describe('claim invitation — what is issued and what is recorded', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('issues one token and audits the send without the link or the address', async () => {
    const { providerId, response } = await submitGuestApplication();

    // Nothing about the token reaches the applicant over HTTP.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('claim-provider');
    expect(body).not.toContain('token');

    const tokens = await ctx.prisma.providerClaimToken.findMany({ where: { providerId } });
    expect(tokens).toHaveLength(1);
    const [issued] = tokens;
    expect(issued!.usedAt).toBeNull();
    expect(issued!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const ttlHours = (issued!.expiresAt.getTime() - issued!.createdAt.getTime()) / 3_600_000;
    expect(Math.round(ttlHours)).toBe(PROVIDER_CLAIM_TOKEN_TTL_HOURS);

    const log = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'provider-claim' },
    });
    expect(log.providerId).toBe(providerId);
    expect(log.status).toBe(NotificationStatus.SENT);
    expect(log.maskedRecipient).toBe('e****@example.test');

    // Neither the raw address nor the token may exist anywhere in the row.
    const raw = JSON.stringify(log);
    expect(raw).not.toContain(APPLICANT_EMAIL);
    expect(raw).not.toContain(lastClaimToken());
    expect(raw).not.toContain('claim-provider');
  });

  it('stores only a hash, never the token itself', async () => {
    const { providerId } = await submitGuestApplication();
    const rawToken = lastClaimToken();

    const tokens = await ctx.prisma.providerClaimToken.findMany({ where: { providerId } });
    expect(JSON.stringify(tokens)).not.toContain(rawToken);
  });

  it('keeps the application when the transport fails, and records FAILED', async () => {
    ctx.notifications.failNextSend = true;
    const category = await createCategory(ctx.prisma);

    const response = await request(ctx.server)
      .post('/providers')
      .send({ ...providerPayload([category.id]), email: APPLICANT_EMAIL })
      .expect(201);

    // The token survives a dead transport — that is exactly the state an admin
    // re-send is for.
    expect(await issuedTokenCount(response.body.id)).toBe(1);

    const log = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'provider-claim' },
    });
    expect(log.status).toBe(NotificationStatus.FAILED);
    expect(log.errorCode).toBe('TRANSPORT_UNAVAILABLE');
  });

  it('invalidates the previous invitation when a new one is issued', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const { providerId } = await submitGuestApplication();
    const firstToken = lastClaimToken();

    await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', cookie)
      .expect(201);

    const secondToken = lastClaimToken();
    expect(secondToken).not.toBe(firstToken);

    await request(ctx.server)
      .get(`/auth/provider-claim?token=${encodeURIComponent(firstToken)}`)
      .expect(400);

    await request(ctx.server)
      .get(`/auth/provider-claim?token=${encodeURIComponent(secondToken)}`)
      .expect(200);
  });
});

describe('claim consume — the happy path', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('creates a provider account, binds the application and signs the applicant in', async () => {
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const validate = await request(ctx.server)
      .get(`/auth/provider-claim?token=${encodeURIComponent(token)}`)
      .expect(200);

    expect(validate.body.outcome).toBe('NEW_ACCOUNT');
    expect(validate.body.maskedEmail).toBe('e****@example.test');
    // The masked address is the only form of it the endpoint may return.
    expect(JSON.stringify(validate.body)).not.toContain(APPLICANT_EMAIL);

    const response = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' })
      .expect(201);

    expect(response.body.user.role).toBe(UserRole.PROVIDER);
    expect(sessionCookieFrom(response)).toContain('taktic_session=');

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).toBe(response.body.user.id);
    expect(provider.claimedAt).not.toBeNull();
    // The application's own details are untouched by the claim.
    expect(provider.email).toBe(APPLICANT_EMAIL);
    expect(provider.status).toBe(ProviderStatus.PENDING_REVIEW);

    const account = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: response.body.user.id },
    });
    expect(account.email).toBe(APPLICANT_EMAIL);
    expect(account.passwordHash).not.toBeNull();

    const consumed = await ctx.prisma.providerClaimToken.findFirstOrThrow({
      where: { providerId },
    });
    expect(consumed.usedAt).not.toBeNull();
  });

  it('lets the new owner reach the provider panel the claim gave them', async () => {
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const claim = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' })
      .expect(201);

    const cookie = sessionCookieFrom(claim);

    const dashboard = await request(ctx.server)
      .get('/providers/me/dashboard')
      .set('Cookie', cookie)
      .expect(200);

    expect(dashboard.body.provider.id).toBe(providerId);
  });

  it('refuses to create an account without a password, without spending the link', async () => {
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const response = await request(ctx.server).post('/auth/provider-claim').send({ token });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PASSWORD_REQUIRED');

    const stored = await ctx.prisma.providerClaimToken.findFirstOrThrow({ where: { providerId } });
    expect(stored.usedAt).toBeNull();
  });
});

describe('claim consume — replay, expiry and status', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('refuses a replayed link and leaves the first owner in place', async () => {
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const first = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' })
      .expect(201);

    const replay = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'BaskaSifre123!' });

    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('CLAIM_TOKEN_INVALID');

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).toBe(first.body.user.id);
    expect(await ctx.prisma.user.count({ where: { role: UserRole.PROVIDER } })).toBe(1);
  });

  it('refuses an expired link', async () => {
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    await ctx.prisma.providerClaimToken.updateMany({
      where: { providerId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const validate = await request(ctx.server).get(
      `/auth/provider-claim?token=${encodeURIComponent(token)}`,
    );
    expect(validate.status).toBe(400);
    expect(validate.body.code).toBe('CLAIM_TOKEN_INVALID');

    const submit = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' });
    expect(submit.status).toBe(400);

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).toBeNull();
  });

  it('gives an unknown token the same answer as an expired one', async () => {
    const response = await request(ctx.server).get('/auth/provider-claim?token=made-up-token');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('CLAIM_TOKEN_INVALID');
  });

  it('dies when the application’s address is corrected after the link was mailed', async () => {
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    await ctx.prisma.providerProfile.update({
      where: { id: providerId },
      data: { email: 'duzeltilmis@example.test' },
    });

    const response = await request(ctx.server).get(
      `/auth/provider-claim?token=${encodeURIComponent(token)}`,
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('CLAIM_TOKEN_INVALID');
  });

  for (const status of [
    ProviderStatus.DRAFT,
    ProviderStatus.REJECTED,
    ProviderStatus.SUSPENDED,
  ] as const) {
    it(`refuses a claim on a ${status} application`, async () => {
      const { providerId } = await submitGuestApplication();
      const token = lastClaimToken();

      await ctx.prisma.providerProfile.update({
        where: { id: providerId },
        data: { status },
      });

      const response = await request(ctx.server)
        .post('/auth/provider-claim')
        .send({ token, password: 'Password123!' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CLAIM_NOT_AVAILABLE');

      const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
        where: { id: providerId },
      });
      expect(provider.userId).toBeNull();
    });
  }

  for (const status of [ProviderStatus.REJECTED, ProviderStatus.SUSPENDED] as const) {
    it(`invalidates live invitations when an application moves to ${status}`, async () => {
      const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
      const cookie = await loginAs(ctx.prisma, admin.id);
      const { providerId } = await submitGuestApplication();

      await request(ctx.server)
        .patch(`/providers/${providerId}/status`)
        .set('Cookie', cookie)
        .send({ status, rejectionReason: 'Belgeler eksik' })
        .expect(200);

      const token = await ctx.prisma.providerClaimToken.findFirstOrThrow({
        where: { providerId },
      });
      expect(token.usedAt).not.toBeNull();
    });
  }

  it('keeps live invitations when an application is approved', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    await request(ctx.server)
      .patch(`/providers/${providerId}/status`)
      .set('Cookie', cookie)
      .send({ status: ProviderStatus.APPROVED })
      .expect(200);

    await request(ctx.server)
      .get(`/auth/provider-claim?token=${encodeURIComponent(token)}`)
      .expect(200);
  });
});

describe('claim consume — accounts that already exist', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('refuses when the address belongs to a customer, and changes no role', async () => {
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: APPLICANT_EMAIL,
    });
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const validate = await request(ctx.server).get(
      `/auth/provider-claim?token=${encodeURIComponent(token)}`,
    );
    expect(validate.status).toBe(409);
    expect(validate.body.code).toBe('EMAIL_BELONGS_TO_CUSTOMER');

    const submit = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' });
    expect(submit.status).toBe(409);
    expect(submit.body.code).toBe('EMAIL_BELONGS_TO_CUSTOMER');

    const unchanged = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(unchanged.role).toBe(UserRole.CUSTOMER);

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).toBeNull();

    const stored = await ctx.prisma.providerClaimToken.findFirstOrThrow({ where: { providerId } });
    expect(stored.usedAt).toBeNull();
  });

  it('refuses the same way for a password-less auto-created customer', async () => {
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: APPLICANT_EMAIL,
      password: null,
      customerOrigin: 'AUTO_CREATED_REQUEST',
    });
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const response = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_BELONGS_TO_CUSTOMER');

    const unchanged = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(unchanged.role).toBe(UserRole.CUSTOMER);
    expect(unchanged.passwordHash).toBeNull();

    const stored = await ctx.prisma.providerClaimToken.findFirstOrThrow({ where: { providerId } });
    expect(stored.usedAt).toBeNull();
  });

  it('asks an existing provider to sign in, without spending the link', async () => {
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, email: APPLICANT_EMAIL });
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const validate = await request(ctx.server)
      .get(`/auth/provider-claim?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(validate.body.outcome).toBe('LOGIN_REQUIRED');

    const anonymous = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' });
    expect(anonymous.status).toBe(409);
    expect(anonymous.body.code).toBe('LOGIN_REQUIRED');

    const stored = await ctx.prisma.providerClaimToken.findFirstOrThrow({ where: { providerId } });
    expect(stored.usedAt).toBeNull();
  });

  it('refuses a different signed-in provider and keeps the link unspent', async () => {
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, email: APPLICANT_EMAIL });
    const stranger = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, stranger.id);
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const response = await request(ctx.server)
      .post('/auth/provider-claim')
      .set('Cookie', cookie)
      .send({ token, password: 'Password123!' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('LOGIN_REQUIRED');

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).toBeNull();

    const stored = await ctx.prisma.providerClaimToken.findFirstOrThrow({ where: { providerId } });
    expect(stored.usedAt).toBeNull();
  });

  it('links the application to the matching provider once they are signed in', async () => {
    const owner = await createUser(ctx.prisma, {
      role: UserRole.PROVIDER,
      email: APPLICANT_EMAIL,
    });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const validate = await request(ctx.server)
      .get(`/auth/provider-claim?token=${encodeURIComponent(token)}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(validate.body.outcome).toBe('LINK_EXISTING_PROVIDER');

    // No password needed, and none may be applied to an account that already
    // has one.
    const before = await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } });

    await request(ctx.server)
      .post('/auth/provider-claim')
      .set('Cookie', cookie)
      .send({ token })
      .expect(201);

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).toBe(owner.id);
    expect(provider.claimedAt).not.toBeNull();

    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await ctx.prisma.user.count({ where: { role: UserRole.PROVIDER } })).toBe(1);
  });

  it('refuses when that provider already owns a profile', async () => {
    const owner = await createUser(ctx.prisma, {
      role: UserRole.PROVIDER,
      email: APPLICANT_EMAIL,
    });
    await createProviderProfile(ctx.prisma, { userId: owner.id });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const response = await request(ctx.server)
      .post('/auth/provider-claim')
      .set('Cookie', cookie)
      .send({ token });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROVIDER_ALREADY_HAS_PROFILE');

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).toBeNull();
  });
});

describe('claim consume — concurrency', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('binds exactly once when two claims arrive together', async () => {
    const { providerId } = await submitGuestApplication();
    const token = lastClaimToken();

    const responses = await Promise.all([
      request(ctx.server).post('/auth/provider-claim').send({ token, password: 'Password123!' }),
      request(ctx.server).post('/auth/provider-claim').send({ token, password: 'Password123!' }),
    ]);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status < 400)).toHaveLength(1);

    for (const response of responses) {
      // A loser gets a business refusal, never a leaked internal error.
      expect(response.status).not.toBe(500);
    }

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).not.toBeNull();
    expect(await ctx.prisma.user.count({ where: { role: UserRole.PROVIDER } })).toBe(1);
    expect(
      await ctx.prisma.providerClaimToken.count({ where: { providerId, usedAt: { not: null } } }),
    ).toBe(1);
  });

  it('binds exactly once when two different links race for one application', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const { providerId } = await submitGuestApplication();
    const firstToken = lastClaimToken();

    await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', cookie)
      .expect(201);
    const secondToken = lastClaimToken();

    const responses = await Promise.all([
      request(ctx.server)
        .post('/auth/provider-claim')
        .send({ token: firstToken, password: 'Password123!' }),
      request(ctx.server)
        .post('/auth/provider-claim')
        .send({ token: secondToken, password: 'Password123!' }),
    ]);

    // Issuing the second link already closed the first, so only one can win —
    // and the loser must still not be a 500.
    expect(responses.filter((response) => response.status < 400)).toHaveLength(1);
    for (const response of responses) {
      expect(response.status).not.toBe(500);
    }

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.userId).not.toBeNull();
    expect(await ctx.prisma.user.count({ where: { role: UserRole.PROVIDER } })).toBe(1);
  });
});

describe('admin invitations — authorisation, payload and budgets', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('is closed to everyone but SUPER_ADMIN', async () => {
    const provider = await createProviderProfile(ctx.prisma, { userId: null });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });

    await request(ctx.server).post(`/providers/${provider.id}/claim-invitations`).expect(401);

    await request(ctx.server)
      .post(`/providers/${provider.id}/claim-invitations`)
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .expect(403);

    await request(ctx.server)
      .post(`/providers/${provider.id}/claim-invitations`)
      .set('Cookie', await loginAs(ctx.prisma, providerUser.id))
      .expect(403);

    expect(await issuedTokenCount(provider.id)).toBe(0);
  });

  it('returns a status and an expiry, and never the link', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const provider = await createProviderProfile(ctx.prisma, {
      userId: null,
      email: APPLICANT_EMAIL,
      status: ProviderStatus.PENDING_REVIEW,
    });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/claim-invitations`)
      .set('Cookie', cookie)
      .expect(201);

    expect(response.body).toEqual({
      status: 'ISSUED',
      expiresAt: expect.any(String),
      delivery: NotificationStatus.SENT,
    });

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(APPLICANT_EMAIL);
    expect(body).not.toContain(lastClaimToken());
    expect(body).not.toContain('claim-provider');
  });

  it('refuses an application that has no address, and one that is already owned', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);

    const addressless = await createProviderProfile(ctx.prisma, { userId: null, email: null });
    const missing = await request(ctx.server)
      .post(`/providers/${addressless.id}/claim-invitations`)
      .set('Cookie', cookie);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('CLAIM_EMAIL_MISSING');

    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owned = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const already = await request(ctx.server)
      .post(`/providers/${owned.id}/claim-invitations`)
      .set('Cookie', cookie);
    expect(already.status).toBe(409);
    expect(already.body.code).toBe('CLAIM_ALREADY_COMPLETED');
  });

  it('lets an admin correct an address and then invite the corrected one', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);
    const { providerId } = await submitGuestApplication('yanlis@example.test');

    await request(ctx.server)
      .patch(`/providers/${providerId}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), email: 'Dogru@Example.test' })
      .expect(200);

    const corrected = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(corrected.email).toBe('dogru@example.test');

    await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', cookie)
      .expect(201);

    const validate = await request(ctx.server)
      .get(`/auth/provider-claim?token=${encodeURIComponent(lastClaimToken())}`)
      .expect(200);
    expect(validate.body.maskedEmail).toBe('d****@example.test');
  });

  it('caps invitations per application and says nothing about which budget ran out', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const { providerId } = await submitGuestApplication();

    // The application's own submission already spent one of the three.
    await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', cookie)
      .expect(201);
    await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', cookie)
      .expect(201);

    const refused = await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', cookie);

    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('CLAIM_RATE_LIMITED');
    expect(refused.body.message).not.toMatch(/provider|ip|adres/i);
    expect(await issuedTokenCount(providerId)).toBe(3);
  });

  it('caps invitations per client address with the identical refusal', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);

    // Eleven separate applications, so only the per-address budget can bite.
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const created = await createProviderProfile(ctx.prisma, {
        userId: null,
        email: `basvuru-${index}@example.test`,
        status: ProviderStatus.PENDING_REVIEW,
      });
      ids.push(created.id);
    }

    for (const providerId of ids.slice(0, 10)) {
      await request(ctx.server)
        .post(`/providers/${providerId}/claim-invitations`)
        .set('Cookie', cookie)
        .expect(201);
    }

    const overBudgetId = ids[10] as string;
    const refused = await request(ctx.server)
      .post(`/providers/${overBudgetId}/claim-invitations`)
      .set('Cookie', cookie);

    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('CLAIM_RATE_LIMITED');
    expect(await issuedTokenCount(overBudgetId)).toBe(0);
  });

  it('never opens a public resend route', async () => {
    const { providerId } = await submitGuestApplication();

    // The only shapes a public caller could reach for.
    for (const path of [
      '/auth/provider-claim/resend',
      '/auth/provider-claim/request',
      `/providers/${providerId}/claim-invitations/resend`,
    ]) {
      const response = await request(ctx.server).post(path).send({ email: APPLICANT_EMAIL });
      expect(response.status).toBe(404);
    }
  });
});

describe('claimed applications — what may still change', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('refuses to move or clear a claimed address, for the owner and the admin alike', async () => {
    const { providerId } = await submitGuestApplication();
    const claim = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token: lastClaimToken(), password: 'Password123!' })
      .expect(201);

    const ownerCookie = sessionCookieFrom(claim);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const category = await createCategory(ctx.prisma);

    for (const cookie of [ownerCookie, adminCookie]) {
      // Moving it, and — the same thing by another name — dropping it.
      for (const email of ['yeni@example.test', null]) {
        const response = await request(ctx.server)
          .patch(`/providers/${providerId}`)
          .set('Cookie', cookie)
          .send({ ...providerPayload([category.id]), email });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('PROVIDER_EMAIL_IMMUTABLE');
      }
    }

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.email).toBe(APPLICANT_EMAIL);
  });

  it('locks on claimedAt itself, not on the endpoint that set it', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, {
      userId: owner.id,
      email: 'sahiplenilmis@example.test',
      claimedAt: new Date(),
    });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const category = await createCategory(ctx.prisma);

    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), email: 'baska@example.test' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROVIDER_EMAIL_IMMUTABLE');
  });

  it('still lets the owner change the phone number', async () => {
    const { providerId } = await submitGuestApplication();
    const claim = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token: lastClaimToken(), password: 'Password123!' })
      .expect(201);

    const cookie = sessionCookieFrom(claim);
    const category = await createCategory(ctx.prisma);

    await request(ctx.server)
      .patch(`/providers/${providerId}`)
      .set('Cookie', cookie)
      .send({
        ...providerPayload([category.id]),
        email: APPLICANT_EMAIL,
        phone: '05559998877',
      })
      .expect(200);

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
    });
    expect(provider.phone).toBe('05559998877');
    expect(provider.email).toBe(APPLICANT_EMAIL);
  });

  it('refuses a second claim on an application that already has an owner', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const { providerId } = await submitGuestApplication();

    // Two live-at-different-times links; the older one is closed by the newer.
    await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', adminCookie)
      .expect(201);
    const token = lastClaimToken();

    await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' })
      .expect(201);

    // A fresh link cannot be issued for an owned application at all…
    const refused = await request(ctx.server)
      .post(`/providers/${providerId}/claim-invitations`)
      .set('Cookie', adminCookie);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CLAIM_ALREADY_COMPLETED');

    // …and a hand-made one would be refused by the consume path too.
    await ctx.prisma.providerClaimToken.updateMany({
      where: { providerId },
      data: { usedAt: null, expiresAt: new Date(Date.now() + 3_600_000) },
    });

    const second = await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token, password: 'Password123!' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CLAIM_ALREADY_COMPLETED');
  });
});

/**
 * The lock is scoped to claimed applications, and this is the boundary.
 *
 * A profile a signed-in provider created for themselves was never claimed: no
 * mailbox was ever vouched for, so there is nothing for the lock to protect and
 * freezing it would be a retroactive restriction on a flow that predates the
 * claim feature entirely. These run with the flag ON, so what they show is that
 * turning the feature on does not reach back into that flow.
 */
describe('unclaimed owned profiles — the claim lock does not reach them', () => {
  beforeEach(() => {
    enableClaim();
  });

  async function bFlowProfile(email?: string | null) {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, {
      userId: owner.id,
      ...(email === undefined ? {} : { email }),
    });
    const cookie = await loginAs(ctx.prisma, owner.id);
    const category = await createCategory(ctx.prisma);

    // The precondition every case here depends on.
    expect(provider.userId).toBe(owner.id);
    expect(provider.claimedAt).toBeNull();

    return { provider, cookie, category };
  }

  it('lets the owner change the contact address', async () => {
    const { provider, cookie, category } = await bFlowProfile();

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), email: 'Guncel@Example.test' })
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(updated.email).toBe('guncel@example.test');
    expect(updated.claimedAt).toBeNull();
  });

  it('lets the owner add an address to a profile that had none', async () => {
    const { provider, cookie, category } = await bFlowProfile(null);
    expect(provider.email).toBeNull();

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), email: 'eklendi@example.test' })
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(updated.email).toBe('eklendi@example.test');
  });

  it('lets the owner clear the address again', async () => {
    const { provider, cookie, category } = await bFlowProfile();

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), email: null })
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(updated.email).toBeNull();
  });

  it('lets an admin change the address too', async () => {
    const { provider, category } = await bFlowProfile();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', adminCookie)
      .send({ ...providerPayload([category.id]), email: 'admin-duzeltti@example.test' })
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(updated.email).toBe('admin-duzeltti@example.test');
  });

  it('lets the owner change the phone number', async () => {
    const { provider, cookie, category } = await bFlowProfile();

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({
        ...providerPayload([category.id]),
        email: provider.email,
        phone: '05557776655',
      })
      .expect(200);

    const updated = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(updated.phone).toBe('05557776655');
    expect(updated.email).toBe(provider.email);
  });
});

describe('admin visibility of ownership', () => {
  beforeEach(() => {
    enableClaim();
  });

  it('filters the application list by ownership', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const unowned = await createProviderProfile(ctx.prisma, { userId: null });
    const owned = await createProviderProfile(ctx.prisma, { userId: owner.id });

    const unclaimed = await request(ctx.server)
      .get('/providers?ownership=unclaimed')
      .set('Cookie', cookie)
      .expect(200);
    expect(unclaimed.body.map((row: { id: string }) => row.id)).toEqual([unowned.id]);

    const claimed = await request(ctx.server)
      .get('/providers?ownership=claimed')
      .set('Cookie', cookie)
      .expect(200);
    expect(claimed.body.map((row: { id: string }) => row.id)).toEqual([owned.id]);

    await request(ctx.server)
      .get('/providers?ownership=nonsense')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('reports claim state on the admin detail without exposing a link', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const { providerId } = await submitGuestApplication();

    const before = await request(ctx.server)
      .get(`/providers/${providerId}/admin-detail`)
      .set('Cookie', cookie)
      .expect(200);

    expect(before.body.claim.ownership).toBe('UNCLAIMED');
    expect(before.body.claim.canInvite).toBe(true);
    expect(before.body.claim.lastInvitation.state).toBe('ACTIVE');
    expect(before.body.claim.lastInvitation.byAdmin).toBe(false);
    expect(JSON.stringify(before.body.claim)).not.toContain(lastClaimToken());
    expect(JSON.stringify(before.body.claim)).not.toContain('claim-provider');

    await request(ctx.server)
      .post('/auth/provider-claim')
      .send({ token: lastClaimToken(), password: 'Password123!' })
      .expect(201);

    const after = await request(ctx.server)
      .get(`/providers/${providerId}/admin-detail`)
      .set('Cookie', cookie)
      .expect(200);

    expect(after.body.claim.ownership).toBe('CLAIMED');
    expect(after.body.claim.canInvite).toBe(false);
    expect(after.body.claim.blockedCode).toBe('CLAIM_ALREADY_COMPLETED');
    expect(after.body.claim.claimedAt).not.toBeNull();
    expect(after.body.claim.lastInvitation.state).toBe('USED');
  });

  it('lets the notification history be narrowed to one application', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const { providerId } = await submitGuestApplication();
    await submitGuestApplication('ikinci@example.test');

    const response = await request(ctx.server)
      .get(`/notification-logs?providerId=${providerId}`)
      .set('Cookie', cookie)
      .expect(200);

    // A guest application produces two messages — the claim invitation and the
    // "we have your application" receipt — and the filter must return both of
    // this application's and none of the other's.
    const items = response.body.items as Array<{ providerId: string; template: string }>;
    expect(items.every((item) => item.providerId === providerId)).toBe(true);
    expect(items.map((item) => item.template).sort()).toEqual([
      'provider-application-received',
      'provider-claim',
    ]);
    expect(JSON.stringify(response.body)).not.toContain(APPLICANT_EMAIL);
  });
});

describe('production boot safety', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOutbox = process.env.NOTIFICATION_OUTBOX_DIR;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalOutbox === undefined) {
      delete process.env.NOTIFICATION_OUTBOX_DIR;
    } else {
      process.env.NOTIFICATION_OUTBOX_DIR = originalOutbox;
    }
  });

  it('refuses to boot in production with the flag on and no delivering transport', () => {
    process.env.NODE_ENV = 'production';
    process.env.PROVIDER_CLAIM_ENABLED = 'true';

    expect(() => assertProviderClaimConfig()).toThrow(/e-mail transport/i);
  });

  it('boots in production with the flag off', () => {
    process.env.NODE_ENV = 'production';
    process.env.PROVIDER_CLAIM_ENABLED = 'false';

    expect(() => assertProviderClaimConfig()).not.toThrow();
  });

  it('boots outside production with the flag on, so the console adapter can be used', () => {
    process.env.NODE_ENV = 'test';
    process.env.PROVIDER_CLAIM_ENABLED = 'true';

    expect(() => assertProviderClaimConfig()).not.toThrow();
  });

  it('refuses the test outbox transport in production, whatever the flag says', () => {
    process.env.NODE_ENV = 'production';
    process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/does-not-matter';

    expect(() => notificationOutboxDir()).toThrow(/test-only transport/i);
  });

  it('fails on a flag value that is neither true nor false', () => {
    process.env.PROVIDER_CLAIM_ENABLED = 'yes';

    expect(() => isProviderClaimEnabled()).toThrow(/exactly "true" or "false"/);
  });

  it('defaults to off when the flag is unset', () => {
    delete process.env.PROVIDER_CLAIM_ENABLED;

    expect(isProviderClaimEnabled()).toBe(false);
  });
});
