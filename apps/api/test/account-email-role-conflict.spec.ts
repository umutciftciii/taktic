import { CustomerOrigin, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CROSS_ROLE_EMAIL_CONFLICT_CODE } from '../src/common/account-email';
import { CUSTOMER_IDENTITY_CONFLICT_CODE } from '../src/common/account-identity';
import { AuthService } from '../src/modules/auth/auth.service';
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

    // One account under the address, and it is the winner's.
    const stored = await ctx.prisma.user.findMany({ where: { email: CONTESTED } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.role).toBe(asCustomer.status === 201 ? UserRole.CUSTOMER : UserRole.PROVIDER);
  });

  /*
   * The window the race above only sometimes hits, forced (CMP-006 PR-C.1):
   * the cross-role pre-check passes, the other kind of account commits, and
   * only then does the contact check read the address. The loser must still
   * get the rule's own sentence, not the generic identity refusal.
   */
  it.each([
    ['customer wins, provider loses', UserRole.CUSTOMER, registerProvider],
    ['provider wins, customer loses', UserRole.PROVIDER, registerCustomer],
  ] as const)('%s before the contact pre-read: still EMAIL_ROLE_CONFLICT', async (_label, winnerRole, loserRegisters) => {
    const auth = ctx.app.get(AuthService) as unknown as { assertContactFree: (email: string, phone: string | null) => Promise<void> };
    const original = auth.assertContactFree.bind(auth);
    const spy = vi.spyOn(auth, 'assertContactFree').mockImplementationOnce(async (email, phone) => {
      await createUser(ctx.prisma, { role: winnerRole, email: CONTESTED, phone: '05553330001' });
      return original(email, phone);
    });
    try {
      const loser = await loserRegisters(CONTESTED, { phone: '05553330002' });
      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
      expect(loser.body.message).toBe(CONFLICT_MESSAGE);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await countUsersFor(CONTESTED)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  /*
   * The same race when the loser's number is also taken (TEST-FLAKE-001).
   *
   * The answer must be a function of who holds the address once the race is
   * decided, not of which read happened to run before the winner committed.
   * Had the winner been there first, the loser would have read the rule's own
   * sentence; the race must not turn that into the generic identity refusal,
   * whether the collision surfaces in the contact pre-read or as the unique
   * index's violation.
   */
  describe('when the loser’s number belongs to a third account', () => {
    const TAKEN_PHONE = '05554440009';

    async function seedPhoneHolder() {
      await createUser(ctx.prisma, {
        role: UserRole.CUSTOMER,
        email: 'ucuncu@example.test',
        phone: TAKEN_PHONE,
        customerOrigin: CustomerOrigin.REGISTERED,
      });
    }

    function spyOnContactCheck() {
      const auth = ctx.app.get(AuthService) as unknown as {
        assertContactFree: (email: string, phone: string | null) => Promise<void>;
      };
      return { auth, original: auth.assertContactFree.bind(auth) };
    }

    it.each([
      ['customer wins, provider loses', UserRole.CUSTOMER, registerProvider],
      ['provider wins, customer loses', UserRole.PROVIDER, registerCustomer],
    ] as const)('%s before the contact read: still EMAIL_ROLE_CONFLICT', async (_label, winnerRole, loserRegisters) => {
      await seedPhoneHolder();
      const { auth, original } = spyOnContactCheck();
      const spy = vi.spyOn(auth, 'assertContactFree').mockImplementationOnce(async (email, phone) => {
        await createUser(ctx.prisma, { role: winnerRole, email: CONTESTED, phone: '05553330001' });
        return original(email, phone);
      });
      try {
        const loser = await loserRegisters(CONTESTED, { phone: TAKEN_PHONE });
        expect(loser.status).toBe(409);
        expect(loser.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
        expect(loser.body.message).toBe(CONFLICT_MESSAGE);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await countUsersFor(CONTESTED)).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['customer wins, provider loses', UserRole.CUSTOMER, registerProvider],
      ['provider wins, customer loses', UserRole.PROVIDER, registerCustomer],
    ] as const)('%s after both reads: still EMAIL_ROLE_CONFLICT from the unique index', async (_label, winnerRole, loserRegisters) => {
      await seedPhoneHolder();
      const { auth } = spyOnContactCheck();
      // Both pre-reads passed before the winner committed: only the insert's
      // unique violation is left to notice, on whichever index it reports.
      const spy = vi.spyOn(auth, 'assertContactFree').mockImplementationOnce(async () => {
        await createUser(ctx.prisma, { role: winnerRole, email: CONTESTED, phone: '05553330001' });
      });
      try {
        const loser = await loserRegisters(CONTESTED, { phone: TAKEN_PHONE });
        expect(loser.status).toBe(409);
        expect(loser.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
        expect(loser.body.message).toBe(CONFLICT_MESSAGE);
        expect(await countUsersFor(CONTESTED)).toBe(1);
        expect(await ctx.prisma.user.count({ where: { phone: { contains: '5554440009' } } })).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    /*
     * Which index PostgreSQL names when a row breaks two of them is a physical
     * detail (index creation order), not part of the rule. The verdict must not
     * depend on it: a violation reported on the phone index still gets the
     * cross-role sentence when the address now belongs to the other kind.
     */
    it.each([
      ['customer wins, provider loses', UserRole.CUSTOMER, registerProvider],
      ['provider wins, customer loses', UserRole.PROVIDER, registerCustomer],
    ] as const)('%s with the violation reported on the phone index: still EMAIL_ROLE_CONFLICT', async (_label, winnerRole, loserRegisters) => {
      const { auth } = spyOnContactCheck();
      const contactSpy = vi.spyOn(auth, 'assertContactFree').mockImplementationOnce(async () => {});
      const createSpy = vi.spyOn(ctx.prisma.user, 'create').mockImplementationOnce((async () => {
        await createUser(ctx.prisma, { role: winnerRole, email: CONTESTED, phone: '05553330001' });
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`phone`)', {
          code: 'P2002',
          clientVersion: Prisma.prismaVersion.client,
          meta: { modelName: 'User', target: ['phone'] },
        });
      }) as never);
      try {
        const loser = await loserRegisters(CONTESTED, { phone: TAKEN_PHONE });
        expect(loser.status).toBe(409);
        expect(loser.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
        // Twice: the forced insert, and the winner it commits inside it.
        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(await countUsersFor(CONTESTED)).toBe(1);
      } finally {
        createSpy.mockRestore();
        contactSpy.mockRestore();
      }
    });

    it('answers the same when the winner was simply there first', async () => {
      await seedPhoneHolder();
      await createUser(ctx.prisma, { role: UserRole.PROVIDER, email: CONTESTED, phone: '05553330001' });

      const loser = await registerCustomer(CONTESTED, { phone: TAKEN_PHONE });

      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    });
  });

  it('lets exactly one of many simultaneous attempts through', async () => {
    const attempts = await Promise.all([
      registerCustomer(CONTESTED, { phone: '05552220001' }),
      registerProvider(CONTESTED, { phone: '05552220002' }),
      registerCustomer(CONTESTED, { phone: '05552220003' }),
      registerProvider(CONTESTED, { phone: '05552220004' }),
    ]);

    const roles = [UserRole.CUSTOMER, UserRole.PROVIDER, UserRole.CUSTOMER, UserRole.PROVIDER];
    const winners = attempts.flatMap((attempt, index) => (attempt.status === 201 ? [roles[index]] : []));
    expect(winners).toHaveLength(1);

    // Every loser gets the answer its relation to the winner calls for: the
    // rule's own sentence across kinds, the ordinary duplicate refusal within
    // one — never a status or code that depends on how the race interleaved.
    attempts.forEach((attempt, index) => {
      if (attempt.status === 201) return;
      expect(attempt.status).toBe(409);
      expect(attempt.body.code).toBe(
        roles[index] === winners[0] ? CUSTOMER_IDENTITY_CONFLICT_CODE : CROSS_ROLE_EMAIL_CONFLICT_CODE,
      );
    });

    const stored = await ctx.prisma.user.findMany({ where: { email: CONTESTED } });
    expect(stored.map((user) => user.role)).toEqual([winners[0]]);
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
