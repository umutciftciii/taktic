import { CustomerOrigin, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CROSS_ROLE_EMAIL_CONFLICT_CODE } from '../src/common/account-email';
import { ProviderClaimRateLimiter } from '../src/modules/provider-claim/provider-claim.rate-limiter';
import {
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  providerPayload,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * One address, one kind of account.
 *
 * The rule is about *accounts*: a person may not hold both an ordinary customer
 * account and a provider account under one address. What makes it a database
 * guarantee rather than a convention is unchanged in shape and only now
 * complete — `User.email` was already unique, and the migration added alongside
 * these tests makes the stored form the normalised one, so the unique index is
 * a case- and whitespace-insensitive one in practice as well as in intent.
 *
 * The service layer's job here is to say *why* in one voice, in front of every
 * flow that could create the second account, and to keep the two paths the rule
 * deliberately does not cover working: a guest service request's auto-created
 * customer, and the activation link that turns it into a real account.
 */

let ctx: TestContext;

/** The address every case in this file fights over. */
const CONTESTED = 'ortak@example.test';

const CONFLICT_MESSAGE = 'Bu e-posta başka türde bir hesap için kullanılıyor.';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  resetAuthThrottle(ctx.app);
  ctx.app.get(ProviderClaimRateLimiter).reset();
  delete process.env.PROVIDER_CLAIM_ENABLED;
});

afterEach(() => {
  delete process.env.PROVIDER_CLAIM_ENABLED;
});

function registerCustomer(email: string, overrides: Record<string, unknown> = {}) {
  return request(ctx.server)
    .post('/auth/register-customer')
    .send({ name: 'Yeni Müşteri', email, password: 'Password123!', ...overrides });
}

function registerProvider(email: string, overrides: Record<string, unknown> = {}) {
  return request(ctx.server)
    .post('/auth/register-provider')
    .send({ name: 'Yeni Esnaf', email, password: 'Password123!', ...overrides });
}

async function submitGuestApplication(email: string) {
  const category = await createCategory(ctx.prisma);
  return request(ctx.server)
    .post('/providers')
    .send({ ...providerPayload([category.id]), email });
}

async function countUsersFor(email: string) {
  return ctx.prisma.user.count({ where: { email: email.trim().toLowerCase() } });
}

describe('cross-role e-mail conflicts are refused with one explicit answer', () => {
  it('refuses a customer registration when a provider account holds the address', async () => {
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, email: CONTESTED });

    const response = await registerCustomer(CONTESTED);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    expect(response.body.message).toBe(CONFLICT_MESSAGE);
    expect(await countUsersFor(CONTESTED)).toBe(1);
  });

  it('refuses a provider registration when a registered customer account holds the address', async () => {
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: CONTESTED,
      customerOrigin: CustomerOrigin.REGISTERED,
    });

    const response = await registerProvider(CONTESTED);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    expect(response.body.message).toBe(CONFLICT_MESSAGE);
    expect(await countUsersFor(CONTESTED)).toBe(1);
  });

  it('refuses a guest provider application filed against a registered customer’s address', async () => {
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: CONTESTED,
      customerOrigin: CustomerOrigin.REGISTERED,
    });

    const response = await submitGuestApplication(CONTESTED);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    expect(response.body.message).toBe(CONFLICT_MESSAGE);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
    // Nothing was mailed to a mailbox that belongs to a customer.
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('says nothing about the account behind the address', async () => {
    await createUser(ctx.prisma, {
      role: UserRole.PROVIDER,
      email: CONTESTED,
      name: 'Ayşe Yılmaz',
    });

    const response = await registerCustomer(CONTESTED);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('Ayşe');
    expect(body).not.toContain(CONTESTED);
    expect(body).not.toContain('PROVIDER');
  });
});

describe('the comparison folds case and surrounding whitespace', () => {
  it('refuses a customer registration for a cased variant of a provider address', async () => {
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, email: CONTESTED });

    const response = await registerCustomer('Ortak@Example.TEST');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    expect(await countUsersFor(CONTESTED)).toBe(1);
  });

  it('refuses a provider registration for a padded variant of a customer address', async () => {
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: CONTESTED,
      customerOrigin: CustomerOrigin.REGISTERED,
    });

    const response = await registerProvider('   ORTAK@example.test  ');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    expect(await countUsersFor(CONTESTED)).toBe(1);
  });

  it('refuses a guest application for a cased variant of a customer address', async () => {
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: CONTESTED,
      customerOrigin: CustomerOrigin.REGISTERED,
    });

    const response = await submitGuestApplication('  ORTAK@Example.test ');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('stores a registered address in its normalised form', async () => {
    await registerCustomer('  Ortak@Example.TEST ').expect(201);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { email: CONTESTED } });
    expect(stored.email).toBe(CONTESTED);
  });
});

/**
 * The rule's teeth, asserted against the database directly rather than through
 * an endpoint.
 *
 * Everything above goes through the service layer, and a service-layer check is
 * something a future caller can forget to run. These two go around it: whatever
 * the application does or fails to do, PostgreSQL will not hold two accounts
 * for one normalised address.
 */
describe('the database refuses what the rule forbids', () => {
  it('refuses to store an address that is not in its normalised form', async () => {
    await expect(
      ctx.prisma.user.create({
        data: { role: UserRole.PROVIDER, name: 'Esnaf', email: 'Ortak@Example.TEST' },
      }),
    ).rejects.toThrow(/User_email_normalized_check/);
  });

  it('refuses a second account whose address differs only by case', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: CONTESTED });

    await expect(
      ctx.prisma.user.create({
        data: { role: UserRole.PROVIDER, name: 'Esnaf', email: 'ORTAK@EXAMPLE.TEST' },
      }),
    ).rejects.toThrow();

    expect(await ctx.prisma.user.count()).toBe(1);
  });
});

describe('the auto-created customer of a guest request is outside the rule', () => {
  /** What a guest service request leaves behind: no password, no registration. */
  function createAutoCustomer() {
    return createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: CONTESTED,
      password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });
  }

  it('still offers the activation link instead of a cross-role refusal', async () => {
    await createAutoCustomer();

    const response = await registerCustomer(CONTESTED);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ACTIVATION_REQUIRED');
    expect(ctx.notifications.ofTemplate('customer-activation')).toHaveLength(1);
  });

  it('still accepts a guest provider application for that address', async () => {
    await createAutoCustomer();

    const response = await submitGuestApplication(CONTESTED);

    expect(response.status).toBe(201);
    const stored = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    expect(stored.email).toBe(CONTESTED);
    expect(stored.userId).toBeNull();
  });
});

describe('two simultaneous cross-role registrations cannot both win', () => {
  it('lets exactly one of them through and refuses the other', async () => {
    const [asCustomer, asProvider] = await Promise.all([
      registerCustomer(CONTESTED, { phone: '05551110001' }),
      registerProvider(CONTESTED, { phone: '05551110002' }),
    ]);

    const statuses = [asCustomer.status, asProvider.status].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = asCustomer.status === 409 ? asCustomer : asProvider;
    expect(loser.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    expect(loser.body.message).toBe(CONFLICT_MESSAGE);

    expect(await countUsersFor(CONTESTED)).toBe(1);
  });

  it('lets exactly one of many simultaneous attempts through', async () => {
    const attempts = await Promise.all([
      registerCustomer(CONTESTED, { phone: '05552220001' }),
      registerProvider(CONTESTED, { phone: '05552220002' }),
      registerCustomer(CONTESTED, { phone: '05552220003' }),
      registerProvider(CONTESTED, { phone: '05552220004' }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 201)).toHaveLength(1);
    expect(await countUsersFor(CONTESTED)).toBe(1);
  });
});

describe('the flows the rule must not touch keep working', () => {
  it('registers a customer and a provider under different addresses', async () => {
    await registerCustomer('musteri@example.test').expect(201);
    await registerProvider('esnaf@example.test').expect(201);

    expect(await countUsersFor('musteri@example.test')).toBe(1);
    expect(await countUsersFor('esnaf@example.test')).toBe(1);
  });

  it('still refuses a second account of the same kind', async () => {
    await createUser(ctx.prisma, {
      role: UserRole.PROVIDER,
      email: 'esnaf@example.test',
    });

    const response = await registerProvider('esnaf@example.test');

    expect(response.status).toBe(409);
    expect(response.body.code).not.toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
  });

  it('signs a registered customer back in', async () => {
    await registerCustomer(CONTESTED).expect(201);

    await request(ctx.server)
      .post('/auth/login')
      .send({ email: 'Ortak@Example.TEST', password: 'Password123!' })
      .expect(201);
  });

  it('refuses to point an unowned application at a customer’s address', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: CONTESTED,
      customerOrigin: CustomerOrigin.REGISTERED,
    });

    const category = await createCategory(ctx.prisma);
    const created = await request(ctx.server)
      .post('/providers')
      .send({ ...providerPayload([category.id]), email: 'baska@example.test' })
      .expect(201);

    const response = await request(ctx.server)
      .patch(`/providers/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), email: CONTESTED });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);

    const unchanged = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(unchanged.email).toBe('baska@example.test');
  });

  it('accepts a guest provider application for an address nobody holds', async () => {
    const response = await submitGuestApplication('yeni-esnaf@example.test');

    expect(response.status).toBe(201);
    expect(await ctx.prisma.providerProfile.count()).toBe(1);
  });

  /**
   * The asymmetry is deliberate, not an oversight.
   *
   * An unowned application is not an account and nobody has proved anything
   * about the address on it — a stranger can type any address into a public
   * form. Letting one stand between a person and their own registration would
   * hand out lockouts for the price of a form submission. What that application
   * cannot do is *become* a provider account here: the claim flow refuses to
   * bind it to a customer, which is the guard that matters and the one
   * provider-claim.spec.ts pins.
   */
  it('lets a customer register at an address that only has a pending application', async () => {
    const application = await submitGuestApplication(CONTESTED);
    expect(application.status).toBe(201);

    await registerCustomer(CONTESTED).expect(201);

    expect(await countUsersFor(CONTESTED)).toBe(1);
  });
});
