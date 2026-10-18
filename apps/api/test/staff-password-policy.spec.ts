import { TEST_ACCOUNT_PASSWORD } from './fixture-password';
import { UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import policy from '@taktic/shared/staff-password-policy.json';
import { bootstrapPasswordProblem } from '../src/common/bootstrap-password';
import {
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_PASSWORD_MIN_LENGTH,
  STAFF_PASSWORD_POLICY_CODE,
  STAFF_PASSWORD_RULE_MESSAGES,
  staffPasswordViolations,
} from '../src/common/staff-password-policy';
import {
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * ADMIN-AUTH-002 — the staff password rule, enforced by the server on every
 * route that gives an ADMIN or SUPER_ADMIN account a new password: accepting an
 * invite, completing a reset link, and changing it while signed in.
 *
 * Three properties are pinned from the outside, over HTTP:
 *
 * - **Staff get the staff rule.** 20–128 characters, at least ten distinct, no
 *   guessable word — refused with a 400 carrying `code` and `rules`, and the
 *   account's stored hash untouched.
 * - **The marketplace keeps its own.** A customer or provider still sets an
 *   eight-character password on the same routes.
 * - **Existing staff passwords keep working.** One shorter than the rule still
 *   signs in, and is still accepted as the *current* password when changing it.
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

const STRONG = 'Dort-mavi-kedi-bulutta-7';
const NINETEEN = 'Mavi-bulut-kedi-7xy';
const TWENTY = `${NINETEEN}z`;
/** Sets its own legacy password: shorter than the staff rule, set before it. */
const LEGACY_SHORT = 'Eski-sifre-9';
const SHORT_FOR_STAFF = 'Sekiz-12';

describe('the rule itself', () => {
  it('reads the shared table the panel reads', () => {
    expect(STAFF_PASSWORD_MIN_LENGTH).toBe(20);
    expect(STAFF_PASSWORD_MAX_LENGTH).toBe(128);
    expect(STAFF_PASSWORD_RULE_MESSAGES).toEqual(policy.messages);
    expect(STAFF_PASSWORD_RULE_MESSAGES.minLength).toContain('20 karakter');
    expect(STAFF_PASSWORD_RULE_MESSAGES.maxLength).toContain('128 karakter');
  });

  it('pins the boundaries and the rule order', () => {
    expect(NINETEEN).toHaveLength(19);
    expect(staffPasswordViolations(NINETEEN)).toEqual(['minLength']);
    expect(staffPasswordViolations(TWENTY)).toEqual([]);
    const max = `${'abcdefghij'.repeat(12)}klmnopqr`;
    expect(staffPasswordViolations(max)).toEqual([]);
    expect(staffPasswordViolations(`${max}s`)).toEqual(['maxLength']);
    expect(staffPasswordViolations('ab'.repeat(15))).toEqual(['distinctCharacters']);
    expect(staffPasswordViolations('Benim-ADMIN-hesabim-9x')).toEqual(['guessable']);
    expect(staffPasswordViolations('YENİ-ŞİFRE-bulut-mavi-7')).toEqual(['guessable']);
    expect(staffPasswordViolations('admin')).toEqual(['minLength', 'distinctCharacters', 'guessable']);
  });

  it('asks for no character class: a lower-case passphrase passes', () => {
    expect(staffPasswordViolations('dört mavi kedi bulutta uyuyor')).toEqual([]);
  });

  it('stays the floor of the bootstrap rule, which adds the generator checks', () => {
    // Everything the staff rule refuses, the bootstrap rule refuses too.
    for (const value of [NINETEEN, 'ab'.repeat(15), 'Benim-ADMIN-hesabim-9x']) {
      expect(bootstrapPasswordProblem(value), value).not.toBeNull();
    }
    // And it adds composition: the staff rule's lower-case passphrase is not a
    // generator's output.
    expect(bootstrapPasswordProblem('dort mavi kedi bulutta uyuyor')).toMatch(/fewer than 3/);
  });
});

async function issueInvite(): Promise<{ userId: string; token: string }> {
  const user = await createUser(ctx.prisma, { role: UserRole.ADMIN, password: null });
  const token = randomBytes(32).toString('base64url');
  await ctx.prisma.adminInviteToken.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { userId: user.id, token };
}

describe('accepting an invite', () => {
  it.each([
    ['minLength', NINETEEN],
    ['maxLength', `${'abcdefghij'.repeat(12)}klmnopqrs`],
    ['distinctCharacters', 'ab'.repeat(15)],
    ['guessable', 'Benim-admin-hesabim-mavi-9'],
  ])('refuses a password breaking %s and sets nothing', async (rule, password) => {
    const { userId, token } = await issueInvite();

    const response = await request(ctx.server).post('/auth/admin-invite').send({ token, password });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(STAFF_PASSWORD_POLICY_CODE);
    expect(response.body.rules).toContain(rule);
    expect(response.body.message).toBe(STAFF_PASSWORD_RULE_MESSAGES[response.body.rules[0] as keyof typeof STAFF_PASSWORD_RULE_MESSAGES]);
    expect(JSON.stringify(response.body)).not.toContain(password);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.passwordHash).toBeNull();
    // The link is not spent by a refused password: the operator tries again.
    const live = await ctx.prisma.adminInviteToken.findFirstOrThrow({ where: { userId } });
    expect(live.usedAt).toBeNull();
  });

  it('refuses an eight-character password with the staff sentence, not a generic one', async () => {
    const { token } = await issueInvite();
    const response = await request(ctx.server)
      .post('/auth/admin-invite')
      .send({ token, password: SHORT_FOR_STAFF })
      .expect(400);
    expect(response.body.message).toBe(STAFF_PASSWORD_RULE_MESSAGES.minLength);
  });

  it('accepts a password of exactly twenty characters', async () => {
    const { userId, token } = await issueInvite();
    await request(ctx.server).post('/auth/admin-invite').send({ token, password: TWENTY }).expect(201);
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await bcrypt.compare(TWENTY, stored.passwordHash!)).toBe(true);
  });

  it('still says a dead link is dead before judging the password', async () => {
    const response = await request(ctx.server)
      .post('/auth/admin-invite')
      .send({ token: 'gecersiz', password: 'kisa' })
      .expect(400);
    expect(response.body.code).toBeUndefined();
  });
});

/**
 * The link mailed to `email` by this request — read by recipient, never as
 * "the last reset mail", so a message addressed to another account can never
 * be mistaken for this one's.
 */
async function resetTokenFor(email: string): Promise<string> {
  const before = ctx.notifications.ofTemplate('password-reset').filter((message) => message.to === email).length;
  await request(ctx.server).post('/auth/password-reset').send({ email }).expect(201);
  const mine = ctx.notifications.ofTemplate('password-reset').filter((message) => message.to === email);
  expect(mine, 'no reset link was mailed to this account').toHaveLength(before + 1);
  const url = mine[mine.length - 1]?.actionUrl;
  if (!url) throw new Error('No reset link was issued.');
  return new URL(url).searchParams.get('token') ?? '';
}

describe('completing a reset link', () => {
  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    'holds a %s to the staff rule and keeps the old password and the link',
    async (role) => {
      const admin = await createUser(ctx.prisma, { role, password: TEST_ACCOUNT_PASSWORD });
      const token = await resetTokenFor(admin.email!);

      const response = await request(ctx.server)
        .post('/auth/password-reset/confirm')
        .send({ token, password: NINETEEN })
        .expect(400);
      expect(response.body.code).toBe(STAFF_PASSWORD_POLICY_CODE);
      expect(response.body.rules).toEqual(['minLength']);

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(await bcrypt.compare(TEST_ACCOUNT_PASSWORD, stored.passwordHash!)).toBe(true);
      expect(stored.emailVerifiedAt).toBeNull();

      // The same link then takes a password that meets the rule.
      await request(ctx.server).post('/auth/password-reset/confirm').send({ token, password: STRONG }).expect(201);
      const reset = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(await bcrypt.compare(STRONG, reset.passwordHash!), 'the reset set this account’s password').toBe(true);
      await request(ctx.server).post('/auth/login').send({ email: admin.email, password: STRONG }).expect(201);
    },
  );

  it.each([UserRole.CUSTOMER, UserRole.PROVIDER])('leaves a %s on the eight-character policy', async (role) => {
    const user = await createUser(ctx.prisma, { role, password: TEST_ACCOUNT_PASSWORD });
    const token = await resetTokenFor(user.email!);
    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token, password: SHORT_FOR_STAFF })
      .expect(201);
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(SHORT_FOR_STAFF, stored.passwordHash!)).toBe(true);
  });
});

function changePassword(cookie: string, currentPassword: string, newPassword: string) {
  return request(ctx.server)
    .post('/account/password')
    .set('Cookie', cookie)
    .send({ currentPassword, newPassword, newPasswordConfirm: newPassword });
}

describe('changing a password while signed in', () => {
  it('holds a staff account to the staff rule', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.ADMIN, password: TEST_ACCOUNT_PASSWORD });
    const cookie = await loginAs(ctx.prisma, admin.id);

    const response = await changePassword(cookie, TEST_ACCOUNT_PASSWORD, 'Benim-admin-hesabim-mavi-9').expect(400);
    expect(response.body.code).toBe(STAFF_PASSWORD_POLICY_CODE);
    expect(response.body.rules).toEqual(['guessable']);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await bcrypt.compare(TEST_ACCOUNT_PASSWORD, stored.passwordHash!)).toBe(true);

    await changePassword(cookie, TEST_ACCOUNT_PASSWORD, STRONG).expect(201);
  });

  it('does not reveal the rule to a caller who gets the current password wrong', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, password: TEST_ACCOUNT_PASSWORD });
    const cookie = await loginAs(ctx.prisma, admin.id);
    const response = await changePassword(cookie, 'yanlis-sifre-000', NINETEEN).expect(400);
    expect(response.body.code).toBeUndefined();
    expect(response.body.message).toBe('Mevcut şifreniz doğrulanamadı.');
  });

  it('leaves a customer on the eight-character policy', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, password: TEST_ACCOUNT_PASSWORD });
    const cookie = await loginAs(ctx.prisma, customer.id);
    await changePassword(cookie, TEST_ACCOUNT_PASSWORD, SHORT_FOR_STAFF).expect(201);
  });
});

describe('staff passwords set before the rule', () => {
  it('still sign in, and are accepted as the current password when replaced', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, password: LEGACY_SHORT });

    const login = await request(ctx.server)
      .post('/auth/login')
      .send({ email: admin.email, password: LEGACY_SHORT })
      .expect(201);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
    expect(cookie).toContain('=');

    // The new one must meet the rule; the old one only has to match its hash.
    await changePassword(cookie, LEGACY_SHORT, LEGACY_SHORT + 'x').expect(400);
    await changePassword(cookie, LEGACY_SHORT, STRONG).expect(201);
    await request(ctx.server).post('/auth/login').send({ email: admin.email, password: STRONG }).expect(201);
  });
});
