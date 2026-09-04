import request from 'supertest';
import { CustomerOrigin, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * A customer's own account: the fields they may change, and their password.
 *
 * Two properties are what these routes exist to guarantee, and both are
 * asserted from the outside — over HTTP, against the real application graph —
 * rather than by reading the service's intentions:
 *
 * - **Only your own account.** There is no id anywhere in these routes, so the
 *   cases below prove the negative the only way it can be proved: a second
 *   customer's row is untouched by anything the first one can post, and a
 *   provider or an operator is refused the screen altogether.
 * - **The password never comes back.** Not in a body, not in a NotificationLog
 *   row, not in an error. The suite greps every response it receives and every
 *   audit row that was written for the plaintext it sent.
 */

let ctx: TestContext;

const CURRENT_PASSWORD = 'MevcutSifre123';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  // The password route shares the credential endpoints' small per-process
  // budget, and several cases here legitimately post to it more than once.
  resetAuthThrottle(ctx.app);
});

type CustomerOverrides = {
  name?: string | null;
  phone?: string | null;
  email?: string;
  password?: string | null;
  customerOrigin?: CustomerOrigin | null;
};

async function signedInCustomer(overrides: CustomerOverrides = {}) {
  const customer = await createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    name: 'Ayşe Yılmaz',
    phone: '05551110001',
    password: CURRENT_PASSWORD,
    ...overrides,
  });

  return { customer, cookie: await loginAs(ctx.prisma, customer.id) };
}

function storedUser(id: string) {
  return ctx.prisma.user.findUniqueOrThrow({ where: { id } });
}

describe('GET /account/profile', () => {
  it('answers with the signed-in customer own account', async () => {
    const { customer, cookie } = await signedInCustomer();

    const response = await request(ctx.server)
      .get('/account/profile')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body).toMatchObject({
      id: customer.id,
      name: 'Ayşe Yılmaz',
      email: customer.email,
      phone: '05551110001',
      city: null,
      hasPassword: true,
    });
    // The stored hash has no business leaving the server, in any shape.
    expect(response.body).not.toHaveProperty('passwordHash');
  });

  it('refuses a caller with no session', async () => {
    await request(ctx.server).get('/account/profile').expect(401);
  });

  it('refuses a provider and an operator', async () => {
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await request(ctx.server)
      .get('/account/profile')
      .set('Cookie', await loginAs(ctx.prisma, provider.id))
      .expect(403);

    await request(ctx.server)
      .get('/account/profile')
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(403);
  });
});

describe('PATCH /account/profile', () => {
  it('updates the name, telephone number and city of the caller own account', async () => {
    const { customer, cookie } = await signedInCustomer();

    const response = await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: '  Ayşe Yılmaz Demir ', phone: '0532 111 22 33', city: 'istanbul' })
      .expect(200);

    expect(response.body).toMatchObject({
      name: 'Ayşe Yılmaz Demir',
      // Canonical forms, not the spellings that were typed: the number in
      // E.164 and the province as turkey-locations publishes it.
      phone: '+905321112233',
      city: 'İstanbul',
    });

    const stored = await storedUser(customer.id);
    expect(stored.name).toBe('Ayşe Yılmaz Demir');
    expect(stored.phone).toBe('+905321112233');
    expect(stored.city).toBe('İstanbul');
  });

  it('leaves every other account alone', async () => {
    const { cookie } = await signedInCustomer();
    const other = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      name: 'Başkası',
      phone: '05559990000',
    });

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      // Every shape a caller might hope names somebody else. The route takes
      // no id at all, so `forbidNonWhitelisted` refuses the body outright.
      .send({ name: 'Yeni İsim', phone: '05321112244', id: other.id, userId: other.id })
      .expect(400);

    const untouched = await storedUser(other.id);
    expect(untouched.name).toBe('Başkası');
    expect(untouched.phone).toBe('05559990000');
  });

  it('refuses a provider, an operator and a caller with no session', async () => {
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const payload = { name: 'Yeni İsim', phone: '05321112255' };

    await request(ctx.server).patch('/account/profile').send(payload).expect(401);

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', await loginAs(ctx.prisma, provider.id))
      .send(payload)
      .expect(403);

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send(payload)
      .expect(403);

    expect(await storedUser(provider.id)).toMatchObject({ name: provider.name });
    expect(await storedUser(admin.id)).toMatchObject({ name: admin.name });
  });

  it('refuses a body that carries an e-mail address, and never changes one', async () => {
    const { customer, cookie } = await signedInCustomer();

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Ayşe Yılmaz', phone: '05551110001', email: 'yeni-adres@example.test' })
      .expect(400);

    expect((await storedUser(customer.id)).email).toBe(customer.email);
  });

  it('refuses an empty or missing name', async () => {
    const { customer, cookie } = await signedInCustomer();

    for (const body of [
      { name: '   ', phone: '05551110001' },
      { name: 'A', phone: '05551110001' },
      { phone: '05551110001' },
    ]) {
      await request(ctx.server)
        .patch('/account/profile')
        .set('Cookie', cookie)
        .send(body)
        .expect(400);
    }

    expect((await storedUser(customer.id)).name).toBe('Ayşe Yılmaz');
  });

  it('refuses a telephone number the platform could not call', async () => {
    const { customer, cookie } = await signedInCustomer();

    // The rule is normalizePhoneNumber's, unchanged: a number it cannot place
    // in a dialling plan is refused rather than stored as typed.
    for (const phone of ['', '   ', '123', 'telefon yok', '05551234']) {
      await request(ctx.server)
        .patch('/account/profile')
        .set('Cookie', cookie)
        .send({ name: 'Ayşe Yılmaz', phone })
        .expect(400);
    }

    expect((await storedUser(customer.id)).phone).toBe('05551110001');
  });

  it('refuses a city that is not a province', async () => {
    const { customer, cookie } = await signedInCustomer();

    for (const city of ['Kadıköy', 'Gotham', '12345']) {
      await request(ctx.server)
        .patch('/account/profile')
        .set('Cookie', cookie)
        .send({ name: 'Ayşe Yılmaz', phone: '05551110001', city })
        .expect(400);
    }

    expect((await storedUser(customer.id)).city).toBeNull();
  });

  it('clears the city on an explicit empty value, and leaves it alone when unmentioned', async () => {
    const { customer, cookie } = await signedInCustomer();

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Ayşe Yılmaz', phone: '05551110001', city: 'Ankara' })
      .expect(200);
    expect((await storedUser(customer.id)).city).toBe('Ankara');

    // A body that never names the field is not a request to lose the value.
    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Ayşe Yılmaz', phone: '05551110001' })
      .expect(200);
    expect((await storedUser(customer.id)).city).toBe('Ankara');

    // An empty one is.
    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Ayşe Yılmaz', phone: '05551110001', city: '' })
      .expect(200);
    expect((await storedUser(customer.id)).city).toBeNull();
  });

  it('refuses a telephone number that already belongs to another account', async () => {
    const { customer, cookie } = await signedInCustomer();
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      name: 'Numara Sahibi',
      phone: '05327778899',
    });

    // The same number, written the way this screen writes it. The other row
    // stores the national spelling, so only a check that knows they are one
    // number catches this.
    const response = await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Ayşe Yılmaz', phone: '+905327778899' })
      .expect(409);

    expect(response.body.message).toContain('başka bir hesaba ait');
    expect((await storedUser(customer.id)).phone).toBe('05551110001');
  });

  it('stays the contact source for a request created afterwards', async () => {
    const { customer, cookie } = await signedInCustomer();
    const category = await createCategory(ctx.prisma, 'Profil sonrası', { offerCreditCost: 1 });

    await request(ctx.server)
      .patch('/account/profile')
      .set('Cookie', cookie)
      .send({ name: 'Ayşe Y. Demir', phone: '0532 444 55 66', city: 'İzmir' })
      .expect(200);

    const created = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: created.body.id },
      select: { customerId: true, customerName: true, customerPhone: true, customerEmail: true },
    });

    expect(stored).toEqual({
      customerId: customer.id,
      customerName: 'Ayşe Y. Demir',
      customerPhone: '+905324445566',
      customerEmail: customer.email,
    });
  });
});

describe('POST /account/password', () => {
  const NEW_PASSWORD = 'YeniSifre456';

  it('changes the password when the current one is right', async () => {
    const { customer, cookie } = await signedInCustomer();
    const before = await storedUser(customer.id);

    const response = await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      })
      .expect(201);

    expect(response.body).toMatchObject({ success: true });
    expect((await storedUser(customer.id)).passwordHash).not.toBe(before.passwordHash);

    // The only proof that matters: the new password opens the account and the
    // old one does not.
    resetAuthThrottle(ctx.app);
    await request(ctx.server)
      .post('/auth/login')
      .send({ email: customer.email, password: NEW_PASSWORD })
      .expect(201);
    await request(ctx.server)
      .post('/auth/login')
      .send({ email: customer.email, password: CURRENT_PASSWORD })
      .expect(401);
  });

  it('revokes every other session and keeps the one it was asked from', async () => {
    const { customer, cookie } = await signedInCustomer();
    const otherCookie = await loginAs(ctx.prisma, customer.id);
    const otherSessionId = otherCookie.split('=')[1];

    const response = await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      })
      .expect(201);

    expect(response.body.otherSessionsRevoked).toBe(1);

    const other = await ctx.prisma.session.findUniqueOrThrow({ where: { id: otherSessionId } });
    expect(other.revokedAt).not.toBeNull();

    // The browser that made the change stays signed in; the other one does not.
    await request(ctx.server).get('/auth/me').set('Cookie', cookie).expect(200);
    await request(ctx.server).get('/auth/me').set('Cookie', otherCookie).expect(401);
  });

  it('spends any password reset link the account still had open', async () => {
    const { customer, cookie } = await signedInCustomer();
    const token = await ctx.prisma.passwordResetToken.create({
      data: {
        userId: customer.id,
        tokenHash: `hash-${customer.id}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      })
      .expect(201);

    const after = await ctx.prisma.passwordResetToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(after.usedAt).not.toBeNull();
  });

  it('refuses a wrong current password without saying anything about the account', async () => {
    const { customer, cookie } = await signedInCustomer();
    const before = await storedUser(customer.id);

    const response = await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: 'YanlisSifre123',
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      })
      .expect(400);

    expect(response.body.message).toBe('Mevcut şifreniz doğrulanamadı.');
    // Nothing about who the account is, whether it exists, or how many tries
    // are left.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(customer.email);
    expect(serialized).not.toContain(customer.id);

    expect((await storedUser(customer.id)).passwordHash).toBe(before.passwordHash);
  });

  it('refuses a new password the policy would not accept', async () => {
    const { customer, cookie } = await signedInCustomer();
    const before = await storedUser(customer.id);

    for (const newPassword of ['kisa', 'a'.repeat(129)]) {
      await request(ctx.server)
        .post('/account/password')
        .set('Cookie', cookie)
        .send({ currentPassword: CURRENT_PASSWORD, newPassword, newPasswordConfirm: newPassword })
        .expect(400);
    }

    // Eight characters and no character class beyond that — the same policy
    // password-policy.spec.ts pins for the two screens that *set* a password.
    await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'abcdefgh',
        newPasswordConfirm: 'abcdefgh',
      })
      .expect(201);

    expect((await storedUser(customer.id)).passwordHash).not.toBe(before.passwordHash);
  });

  it('refuses a confirmation that does not match', async () => {
    const { customer, cookie } = await signedInCustomer();
    const before = await storedUser(customer.id);

    const response = await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: `${NEW_PASSWORD}7`,
      })
      .expect(400);

    expect(response.body.message).toContain('tekrarı');
    expect((await storedUser(customer.id)).passwordHash).toBe(before.passwordHash);
  });

  it('refuses a new password identical to the current one', async () => {
    const { customer, cookie } = await signedInCustomer();
    const before = await storedUser(customer.id);

    const response = await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: CURRENT_PASSWORD,
        newPasswordConfirm: CURRENT_PASSWORD,
      })
      .expect(400);

    expect(response.body.message).toContain('farklı olmalı');
    expect((await storedUser(customer.id)).passwordHash).toBe(before.passwordHash);
  });

  it('sends an account with no password to activation instead of a form it cannot use', async () => {
    // The shape the platform creates for a guest service request: an account,
    // an address, and no password until the activation link is followed.
    const { customer, cookie } = await signedInCustomer({
      password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });

    const response = await request(ctx.server)
      .post('/account/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: 'herhangi',
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      })
      .expect(409);

    expect(response.body.code).toBe('PASSWORD_NOT_SET');
    expect(response.body.message).toContain('etkinleştirme');
    // Still no password: the refusal must not have set one on the way past.
    expect((await storedUser(customer.id)).passwordHash).toBeNull();

    const profile = await request(ctx.server)
      .get('/account/profile')
      .set('Cookie', cookie)
      .expect(200);
    expect(profile.body.hasPassword).toBe(false);
  });

  it('refuses a caller with no session', async () => {
    await request(ctx.server)
      .post('/account/password')
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      })
      .expect(401);
  });

  it('never lets a plaintext password reach a response or an audit row', async () => {
    const { customer, cookie } = await signedInCustomer();

    const responses = [
      // The refusals, which are the ones that hold a wrong password.
      await request(ctx.server)
        .post('/account/password')
        .set('Cookie', cookie)
        .send({
          currentPassword: 'YanlisSifre123',
          newPassword: NEW_PASSWORD,
          newPasswordConfirm: NEW_PASSWORD,
        }),
      await request(ctx.server)
        .post('/account/password')
        .set('Cookie', cookie)
        .send({
          currentPassword: CURRENT_PASSWORD,
          newPassword: 'kisa',
          newPasswordConfirm: 'kisa',
        }),
      // And the success, which holds both.
      await request(ctx.server)
        .post('/account/password')
        .set('Cookie', cookie)
        .send({
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
          newPasswordConfirm: NEW_PASSWORD,
        }),
      await request(ctx.server).get('/account/profile').set('Cookie', cookie),
      await request(ctx.server).get('/auth/me').set('Cookie', cookie),
    ];

    for (const response of responses) {
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(CURRENT_PASSWORD);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain('passwordHash');
    }

    // Nothing was mailed about it, and nothing was written to the audit trail
    // that could carry it.
    expect(ctx.notifications.sent).toHaveLength(0);
    const auditRows = await ctx.prisma.notificationLog.findMany({ where: { userId: customer.id } });
    const auditSerialized = JSON.stringify(auditRows);
    expect(auditSerialized).not.toContain(CURRENT_PASSWORD);
    expect(auditSerialized).not.toContain(NEW_PASSWORD);

    // And the stored value is a hash of the new password, not the password.
    const stored = await storedUser(customer.id);
    expect(stored.passwordHash).not.toBe(NEW_PASSWORD);
    expect(stored.passwordHash?.startsWith('$2')).toBe(true);
  });
});
