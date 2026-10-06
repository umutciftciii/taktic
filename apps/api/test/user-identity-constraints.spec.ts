import { Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CROSS_ROLE_EMAIL_CONFLICT_CODE } from '../src/common/account-email';
import { CUSTOMER_IDENTITY_CONFLICT_CODE, uniqueViolationField } from '../src/common/account-identity';
import { AuthService } from '../src/modules/auth/auth.service';
import { ADMIN_USER_EMAIL_CONFLICT, ADMIN_USER_PHONE_CONFLICT } from '../src/modules/users/users.service';
import {
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * AUTH-REG-002: the database is the last line for "one number, one address,
 * one account".
 *
 * User_phone_e164_check makes E.164 the only storable number and
 * User_email_normalized_check the only storable address; the two byte-exact
 * unique indexes over those single forms then refuse an equivalent second
 * account however the request was spelled and however two requests interleave.
 * The application's pre-reads stay for the answer they give, but nothing here
 * depends on them: each race below is decided by the index, and the loser gets
 * the same stable answer it would have got had the winner been there first.
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
  ctx.notifications.clear();
  resetAuthThrottle(ctx.app);
});

const PROFILE_PHONE_TAKEN = 'Bu telefon numarası başka bir hesaba ait.';

function insertRaw(phone: string | null, email: string) {
  return ctx.prisma.user.create({ data: { role: UserRole.CUSTOMER, phone, email } });
}

function register(kind: 'customer' | 'provider', body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/auth/register-${kind}`)
    .send({ name: 'Yarışan Kişi', password: 'GucluSifre123!', ...body });
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: null });
  return loginAs(ctx.prisma, admin.id);
}

describe('the User table', () => {
  it('stores a canonical number', async () => {
    const user = await insertRaw('+905321234567', 'a@example.test');
    expect(user.phone).toBe('+905321234567');
    // International numbers stay storable: no country-specific rule in SQL.
    expect((await insertRaw('+4930123456', 'b@example.test')).phone).toBe('+4930123456');
  });

  it.each(['05321234567', '5321234567', '905321234567', '', ' +905321234567', '+90 532 123 45 67', '+90532123456a'])(
    'refuses %j and leaves no row behind',
    async (phone) => {
      await expect(insertRaw(phone, 'x@example.test')).rejects.toThrow(/User_phone_e164_check/);
      expect(await ctx.prisma.user.count()).toBe(0);
    },
  );

  it('refuses a non-canonical number on update too', async () => {
    const user = await insertRaw('+905321234567', 'a@example.test');
    await expect(
      ctx.prisma.user.update({ where: { id: user.id }, data: { phone: '05321234567' } }),
    ).rejects.toThrow(/User_phone_e164_check/);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).phone).toBe('+905321234567');
  });

  it('refuses the same canonical number twice with the unique index', async () => {
    await insertRaw('+905321234567', 'a@example.test');
    const error = await insertRaw('+905321234567', 'b@example.test').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(uniqueViolationField(error)).toBe('phone');
  });

  it('admits any number of accounts without a number', async () => {
    await insertRaw(null, 'a@example.test');
    await insertRaw(null, 'b@example.test');
    await insertRaw(null, 'c@example.test');
    expect(await ctx.prisma.user.count({ where: { phone: null } })).toBe(3);
  });

  it('does not let a CHECK violation pass for a conflict', async () => {
    // A value that reached an insert without being canonicalised is a
    // programming error. The mapping every creation path shares must not turn
    // it into "this number belongs to somebody".
    const error = await insertRaw('05321234567', 'a@example.test').catch((caught: unknown) => caught);
    expect(uniqueViolationField(error)).toBeNull();
  });

  it('refuses an address that differs only by case, and one that is not folded', async () => {
    await insertRaw(null, 'ayse@example.test');
    const duplicate = await insertRaw(null, 'ayse@example.test').catch((caught: unknown) => caught);
    expect(uniqueViolationField(duplicate)).toBe('email');
    await expect(insertRaw(null, 'Ayse@example.test')).rejects.toThrow(/User_email_normalized_check/);
  });
});

describe('registration races are decided by the index', () => {
  it('lets one of two simultaneous registrations under one number through, whatever the spelling and the kind', async () => {
    const [customer, provider] = await Promise.all([
      register('customer', { email: 'musteri@example.test', phone: '0532 123 45 67' }),
      register('provider', { email: 'usta@example.test', phone: '+90 532 123 45 67' }),
    ]);

    expect([customer.status, provider.status].sort()).toEqual([201, 409]);
    const loser = customer.status === 409 ? customer : provider;
    expect(loser.body.code).toBe(CUSTOMER_IDENTITY_CONFLICT_CODE);
    expect(await ctx.prisma.user.findMany({ where: { phone: '+905321234567' } })).toHaveLength(1);
  });

  it.each(['customer', 'provider'] as const)(
    'answers a %s registration that loses the number at the insert like one that lost it at the pre-read',
    async (kind) => {
      // The pre-read runs and finds nothing; the winner commits right after.
      // Only User_phone_key stands between the two accounts now.
      const auth = ctx.app.get(AuthService) as unknown as {
        assertContactFree: (email: string, phone: string | null) => Promise<void>;
      };
      const spy = vi.spyOn(auth, 'assertContactFree').mockImplementationOnce(async () => {
        await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05321234567', email: 'winner@example.test' });
      });
      try {
        const loser = await register(kind, { email: 'loser@example.test', phone: '+90 532 123 45 67' });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(loser.status).toBe(409);
        expect(loser.body.code).toBe(CUSTOMER_IDENTITY_CONFLICT_CODE);
        expect(await ctx.prisma.user.count({ where: { phone: '+905321234567' } })).toBe(1);
        expect(await ctx.prisma.user.count({ where: { email: 'loser@example.test' } })).toBe(0);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('keeps the cross-role answer when the address is the field that collides (PR #146)', async () => {
    const auth = ctx.app.get(AuthService) as unknown as {
      assertContactFree: (email: string, phone: string | null) => Promise<void>;
    };
    const spy = vi.spyOn(auth, 'assertContactFree').mockImplementationOnce(async () => {
      await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05321234567', email: 'ortak@example.test' });
    });
    try {
      // Both fields collide; whichever index PostgreSQL reports, the answer is
      // the cross-role rule's.
      const loser = await register('customer', { email: 'Ortak@Example.test', phone: '05321234567' });
      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe(CROSS_ROLE_EMAIL_CONFLICT_CODE);
    } finally {
      spy.mockRestore();
    }
  });

  it('lets one of several simultaneous same-kind registrations under one address through, whatever its case', async () => {
    const responses = await Promise.all(
      ['ayse@example.test', 'AYSE@example.test', ' Ayse@Example.test '].map((email, index) =>
        register('customer', { email, phone: `0532 111 22 0${index}` }),
      ),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(response.body.code).toBe(CUSTOMER_IDENTITY_CONFLICT_CODE);
    }
    expect(await ctx.prisma.user.count({ where: { email: 'ayse@example.test' } })).toBe(1);
  });
});

describe('a profile number change racing another account', () => {
  it('lets one of two customers take the number and gives the other the stable phone-taken answer', async () => {
    const first = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05551110001', password: 'Password123!' });
    const second = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05551110002', password: 'Password123!' });
    const [firstCookie, secondCookie] = await Promise.all([loginAs(ctx.prisma, first.id), loginAs(ctx.prisma, second.id)]);

    const responses = await Promise.all([
      request(ctx.server).patch('/account/profile').set('Cookie', firstCookie).send({ name: 'Bir', phone: '0532 123 45 67' }),
      request(ctx.server).patch('/account/profile').set('Cookie', secondCookie).send({ name: 'İki', phone: '+905321234567' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)!.body.message).toBe(PROFILE_PHONE_TAKEN);
    expect(await ctx.prisma.user.count({ where: { phone: '+905321234567' } })).toBe(1);
  });
});

describe('POST /users answers a conflict with a machine-readable code', () => {
  it('names the address conflict', async () => {
    const cookie = await adminCookie();
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: 'taken@example.test' });

    const response = await request(ctx.server)
      .post('/users')
      .set('Cookie', cookie)
      .send({ name: 'Yeni Operatör', email: ' Taken@Example.test ' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: ADMIN_USER_EMAIL_CONFLICT,
      message: 'Bu e-posta başka bir kullanıcıya ait.',
    });
  });

  it('names the number conflict', async () => {
    const cookie = await adminCookie();
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05321234567' });

    const response = await request(ctx.server)
      .post('/users')
      .set('Cookie', cookie)
      .send({ name: 'Yeni Operatör', email: 'op@example.test', phone: '532 123 45 67' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: ADMIN_USER_PHONE_CONFLICT,
      message: 'Bu telefon başka bir kullanıcıya ait.',
    });
  });

  it('gives the loser of simultaneous creates the same code the pre-read would have', async () => {
    const cookie = await adminCookie();
    const spellings = ['0532 123 45 67', '+905321234567', '905321234567'];

    const responses = await Promise.all(
      spellings.map((phone, index) =>
        request(ctx.server)
          .post('/users')
          .set('Cookie', cookie)
          .send({ name: `Operatör ${index}`, email: `op${index}@example.test`, phone }),
      ),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(response.body.code).toBe(ADMIN_USER_PHONE_CONFLICT);
    }
    expect(await ctx.prisma.user.count({ where: { phone: '+905321234567' } })).toBe(1);
  });
});
