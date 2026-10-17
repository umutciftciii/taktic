import { Prisma, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BootstrapPasswordRefused,
  bootstrapPasswordProblem,
  requireBootstrapPassword,
} from '../src/common/bootstrap-password';
import {
  applyPromote,
  applyRecover,
  applyRename,
  applyRetire,
  applyRollback,
  inspect,
  maskEmail,
  parseArgs,
  planPromote,
  planRollback,
  TransitionRefused,
  type Manifest,
} from '../src/scripts/super-admin-transition';
import { generateFixturePassword, TEST_ACCOUNT_PASSWORD } from './fixture-password';
import { createTestApp, createUser, loginAs, resetAuthThrottle, resetDatabase, type TestContext } from './harness';

/**
 * The super-admin transition (STG-003), against the real tables and, where the
 * property is the whole flow, the real HTTP routes.
 *
 * The invariant every case leans on: at no point — after any step, or after
 * any rollback — is the platform left without an active super admin who can
 * sign in.
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

const TARGET = 'hedef.yonetici@example.test';
const STRONG = generateFixturePassword();

function step<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return ctx.prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function seedSuperAdmin() {
  return createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, email: 'admin@taktic.local', password: TEST_ACCOUNT_PASSWORD });
}

async function seedProvenAdmin(email = TARGET) {
  const admin = await createUser(ctx.prisma, { role: UserRole.ADMIN, email, password: TEST_ACCOUNT_PASSWORD });
  return ctx.prisma.user.update({ where: { id: admin.id }, data: { emailVerifiedAt: new Date() } });
}

async function liveSessions(userId: string) {
  return ctx.prisma.session.count({ where: { userId, revokedAt: null } });
}

async function openResetLinks(userId: string) {
  return ctx.prisma.passwordResetToken.count({ where: { userId, usedAt: null } });
}

async function issueResetLink(userId: string) {
  await ctx.prisma.passwordResetToken.create({
    data: { userId, tokenHash: `hash-${userId}-${Date.now()}`, expiresAt: new Date(Date.now() + 3_600_000) },
  });
}

async function usableSuperAdmins() {
  return ctx.prisma.user.count({ where: { role: UserRole.SUPER_ADMIN, isActive: true, passwordHash: { not: null } } });
}

describe('inspect', () => {
  it('chooses path B when nobody holds the address, and masks every address', async () => {
    await seedSuperAdmin();
    const result = await step((tx) => inspect(tx, TARGET));

    expect(result.path).toBe('B-rename');
    expect(result.usableSuperAdmins).toBe(1);
    expect(result.superAdmins).toHaveLength(1);
    expect(result.superAdmins[0]?.email).toBe('a***@taktic.local');
    expect(JSON.stringify(result)).not.toContain('admin@taktic.local');
    expect(JSON.stringify(result)).not.toContain('$2');
  });

  it('refuses a marketplace account and reports what it carries', async () => {
    await seedSuperAdmin();
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: TARGET });
    const result = await step((tx) => inspect(tx, TARGET));

    expect(result.path).toBe('refused');
    expect(result.target.kind).toBe('present');
    if (result.target.kind === 'present') {
      expect(result.target.account.role).toBe(UserRole.CUSTOMER);
      expect(result.target.relations).toEqual({ serviceRequests: 0, providerProfile: false, liveRoleAssignments: 0 });
    }
  });

  it('chooses path A for a staff account and says when its address is unproven', async () => {
    await seedSuperAdmin();
    await createUser(ctx.prisma, { role: UserRole.ADMIN, email: TARGET });
    const result = await step((tx) => inspect(tx, TARGET));

    expect(result.path).toBe('A-promote');
    expect(result.notes.join(' ')).toContain('Şifremi unuttum');
  });
});

describe('path A — promote, then retire', () => {
  it('refuses to promote an address nobody has proven', async () => {
    await seedSuperAdmin();
    const admin = await createUser(ctx.prisma, { role: UserRole.ADMIN, email: TARGET });

    expect((await step((tx) => planPromote(tx, TARGET))).join(' ')).toContain('not proven');
    await expect(step((tx) => applyPromote(tx, TARGET))).rejects.toBeInstanceOf(TransitionRefused);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe(UserRole.ADMIN);
  });

  it('never promotes a customer or a provider, proven or not', async () => {
    await seedSuperAdmin();
    for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER]) {
      await resetDatabase(ctx.prisma);
      await seedSuperAdmin();
      const user = await createUser(ctx.prisma, { role, email: TARGET });
      await ctx.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });

      await expect(step((tx) => applyPromote(tx, TARGET))).rejects.toBeInstanceOf(TransitionRefused);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe(role);
    }
  });

  it('refuses an inactive or password-less staff account', async () => {
    await seedSuperAdmin();
    const admin = await createUser(ctx.prisma, { role: UserRole.ADMIN, email: TARGET, password: null, isActive: false });
    await ctx.prisma.user.update({ where: { id: admin.id }, data: { emailVerifiedAt: new Date() } });

    const refusals = await step((tx) => planPromote(tx, TARGET));
    expect(refusals.join(' ')).toContain('inactive');
    expect(refusals.join(' ')).toContain('no password');
  });

  it('promotes a proven ADMIN, closes its sessions, and leaves the old super admin in place', async () => {
    const old = await seedSuperAdmin();
    const target = await seedProvenAdmin();
    await loginAs(ctx.prisma, target.id);
    await issueResetLink(target.id);

    const manifest = await step((tx) => applyPromote(tx, TARGET));

    expect(manifest).toMatchObject({ action: 'promote', userId: target.id, before: { role: 'ADMIN' }, after: { role: 'SUPER_ADMIN' }, sessionsRevoked: 1 });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe(UserRole.SUPER_ADMIN);
    expect(await liveSessions(target.id)).toBe(0);
    expect(await openResetLinks(target.id)).toBe(0);
    // Two super admins until retire: access is never a single point.
    const stillOld = await ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } });
    expect(stillOld).toMatchObject({ role: UserRole.SUPER_ADMIN, isActive: true });
    expect(await usableSuperAdmins()).toBe(2);
  });

  it('retires the old super admin only after the new one has signed in since its promotion', async () => {
    const old = await seedSuperAdmin();
    await seedProvenAdmin();
    await loginAs(ctx.prisma, old.id);
    const promotion = await step((tx) => applyPromote(tx, TARGET, new Date(Date.now() - 1_000)));
    const input = { fromId: old.id, targetEmail: TARGET, promotedAt: new Date(promotion.appliedAt) };

    await expect(step((tx) => applyRetire(tx, input))).rejects.toThrow(/has not signed in since/);

    // The new super admin signs in through the real route.
    await request(ctx.server).post('/auth/login').send({ email: TARGET, password: TEST_ACCOUNT_PASSWORD }).expect(201);
    const manifest = await step((tx) => applyRetire(tx, input));

    expect(manifest).toMatchObject({ action: 'retire', userId: old.id, successorId: promotion.userId, sessionsRevoked: 1 });
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ role: UserRole.ADMIN, isActive: false });
    expect(await liveSessions(old.id)).toBe(0);
    const audit = await ctx.prisma.accountStatusChange.findFirstOrThrow({ where: { userId: old.id } });
    expect(audit).toMatchObject({ fromActive: true, toActive: false, actorId: promotion.userId, userRole: UserRole.SUPER_ADMIN });
    expect(await usableSuperAdmins()).toBe(1);

    // The retired account cannot sign in any more.
    await request(ctx.server)
      .post('/auth/login')
      .send({ email: 'admin@taktic.local', password: TEST_ACCOUNT_PASSWORD })
      .expect((response) => expect(response.status).toBeGreaterThanOrEqual(400));
  });

  it('refuses to retire the successor itself', async () => {
    const only = await seedSuperAdmin();
    await loginAs(ctx.prisma, only.id);
    await expect(
      step((tx) => applyRetire(tx, { fromId: only.id, targetEmail: 'admin@taktic.local', promotedAt: null })),
    ).rejects.toThrow(/successor itself/);
    expect(await usableSuperAdmins()).toBe(1);
  });

  it('rolls a promote back only while another super admin remains', async () => {
    const old = await seedSuperAdmin();
    const target = await seedProvenAdmin();
    const promotion = await step((tx) => applyPromote(tx, TARGET));

    await ctx.prisma.user.update({ where: { id: old.id }, data: { isActive: false } });
    expect((await step((tx) => planRollback(tx, promotion))).join(' ')).toContain('would leave none');

    await ctx.prisma.user.update({ where: { id: old.id }, data: { isActive: true } });
    await step((tx) => applyRollback(tx, promotion));
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe(UserRole.ADMIN);
    expect(await usableSuperAdmins()).toBe(1);
  });

  it('rolls a retire back to an active super admin', async () => {
    const old = await seedSuperAdmin();
    await seedProvenAdmin();
    const promotion = await step((tx) => applyPromote(tx, TARGET, new Date(Date.now() - 1_000)));
    await loginAs(ctx.prisma, promotion.userId);
    const retire = await step((tx) => applyRetire(tx, { fromId: old.id, targetEmail: TARGET, promotedAt: null }));

    await step((tx) => applyRollback(tx, retire));
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ role: UserRole.SUPER_ADMIN, isActive: true });
    expect(await ctx.prisma.accountStatusChange.count({ where: { userId: old.id } })).toBe(2);
    expect(await usableSuperAdmins()).toBe(2);
  });
});

describe('path B — rename the existing super admin', () => {
  it('refuses an address somebody already holds', async () => {
    const old = await seedSuperAdmin();
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: TARGET });
    await expect(step((tx) => applyRename(tx, { fromId: old.id, targetEmail: TARGET, newPassword: STRONG }))).rejects.toThrow(
      /already held by a CUSTOMER/,
    );
  });

  it('moves the address, rotates the password, closes everything, and never loses the super admin', async () => {
    const old = await seedSuperAdmin();
    const staleCookie = await loginAs(ctx.prisma, old.id);
    await issueResetLink(old.id);
    await ctx.prisma.user.update({ where: { id: old.id }, data: { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') } });

    const manifest = await step((tx) => applyRename(tx, { fromId: old.id, targetEmail: TARGET, newPassword: STRONG }));

    expect(manifest).toMatchObject({
      action: 'rename',
      userId: old.id,
      before: { email: 'admin@taktic.local', emailVerifiedAt: '2026-01-01T00:00:00.000Z' },
      after: { email: TARGET, emailVerifiedAt: null },
      passwordRotated: true,
      sessionsRevoked: 1,
    });
    expect(JSON.stringify(manifest)).not.toContain(STRONG);
    const renamed = await ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } });
    expect(renamed).toMatchObject({ email: TARGET, role: UserRole.SUPER_ADMIN, isActive: true, emailVerifiedAt: null });
    expect(await bcrypt.compare(STRONG, renamed.passwordHash!)).toBe(true);
    expect(await bcrypt.compare(TEST_ACCOUNT_PASSWORD, renamed.passwordHash!)).toBe(false);
    expect(await openResetLinks(old.id)).toBe(0);
    await request(ctx.server).get('/auth/me').set('Cookie', staleCookie).expect(401);
    expect(await usableSuperAdmins()).toBe(1);

    // The old address and the old password both stop working; the new pair works.
    await request(ctx.server)
      .post('/auth/login')
      .send({ email: 'admin@taktic.local', password: TEST_ACCOUNT_PASSWORD })
      .expect((response) => expect(response.status).toBeGreaterThanOrEqual(400));
    await request(ctx.server).post('/auth/login').send({ email: TARGET, password: STRONG }).expect(201);

    // The owner proves the new mailbox with "Şifremi unuttum".
    await request(ctx.server).post('/auth/password-reset').send({ email: TARGET }).expect(201);
    const resetUrl = ctx.notifications.lastOfTemplate('password-reset')?.actionUrl;
    expect(resetUrl).toBeTruthy();
    const ownersPassword = generateFixturePassword();
    await request(ctx.server)
      .post('/auth/password-reset/confirm')
      .send({ token: new URL(resetUrl!).searchParams.get('token'), password: ownersPassword })
      .expect(201);
    const proven = await ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } });
    expect(proven.emailVerifiedAt).not.toBeNull();
    await request(ctx.server).post('/auth/login').send({ email: TARGET, password: ownersPassword }).expect(201);
  });

  it('keeps the current password when asked to', async () => {
    const old = await seedSuperAdmin();
    const manifest = await step((tx) => applyRename(tx, { fromId: old.id, targetEmail: TARGET, newPassword: null }));
    expect(manifest.passwordRotated).toBe(false);
    await request(ctx.server).post('/auth/login').send({ email: TARGET, password: TEST_ACCOUNT_PASSWORD }).expect(201);
  });

  it('rolls a rename back while the old address is free, and refuses once it is not', async () => {
    const old = await seedSuperAdmin();
    const manifest = await step((tx) => applyRename(tx, { fromId: old.id, targetEmail: TARGET, newPassword: STRONG }));

    const squatter = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: 'admin@taktic.local' });
    expect((await step((tx) => planRollback(tx, manifest))).join(' ')).toContain('held by another account');
    await ctx.prisma.user.delete({ where: { id: squatter.id } });

    await step((tx) => applyRollback(tx, manifest));
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ email: 'admin@taktic.local', emailVerifiedAt: null });
    expect(await usableSuperAdmins()).toBe(1);
  });
});

describe('recover-password', () => {
  it('sets a super admin password from the operator and closes its sessions', async () => {
    const admin = await seedSuperAdmin();
    await loginAs(ctx.prisma, admin.id);

    const manifest = await step((tx) => applyRecover(tx, admin.id, STRONG));

    expect(manifest).toMatchObject({ action: 'recover-password', userId: admin.id, sessionsRevoked: 1 });
    expect(JSON.stringify(manifest)).not.toContain(STRONG);
    await request(ctx.server).post('/auth/login').send({ email: 'admin@taktic.local', password: STRONG }).expect(201);
  });

  it('is for a super admin only, and is never rolled back', async () => {
    await seedSuperAdmin();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await expect(step((tx) => applyRecover(tx, customer.id, STRONG))).rejects.toBeInstanceOf(TransitionRefused);

    const manifest: Manifest = { version: 1, action: 'recover-password', appliedAt: new Date().toISOString(), userId: customer.id, sessionsRevoked: 0 };
    expect((await step((tx) => planRollback(tx, manifest))).join(' ')).toContain('not rolled back');
  });
});

describe('command line', () => {
  it('asks for a pointed-at address twice', () => {
    expect(() => parseArgs(['promote', '--to', TARGET])).toThrow(/--confirm-to/);
    expect(() => parseArgs(['rename', '--from-id', 'x', '--to', TARGET, '--confirm-to', 'baska@example.test'])).toThrow(/--confirm-to/);
    expect(parseArgs(['--', 'promote', '--to', ` ${TARGET.toUpperCase()} `, '--confirm-to', TARGET])).toMatchObject({ command: 'promote', to: TARGET, apply: false });
  });

  it('is a dry run unless told otherwise, and inspect never writes', () => {
    expect(parseArgs(['retire', '--from-id', 'x', '--to', TARGET]).apply).toBe(false);
    expect(() => parseArgs(['inspect', '--to', TARGET, '--apply'])).toThrow(/only reads/);
    expect(() => parseArgs(['rollback'])).toThrow(/--manifest/);
    expect(() => parseArgs(['delete-everything'])).toThrow(/first argument/);
  });

  it('masks addresses', () => {
    expect(maskEmail('umut@example.test')).toBe('u***@example.test');
    expect(maskEmail(null)).toBe('(none)');
  });
});

describe('bootstrap password rule', () => {
  it('refuses unset, short, low-variety and guessable values without repeating them', () => {
    const guessable = `Sifre-${'Taktic'}-Panel-2026-xyz`;
    expect(bootstrapPasswordProblem(undefined)).toBe('is not set');
    expect(bootstrapPasswordProblem('Kisa1!')).toMatch(/shorter/);
    expect(bootstrapPasswordProblem('aaaaaaaaaaaaaaaaaaaaaaaa')).toMatch(/fewer than 3/);
    expect(bootstrapPasswordProblem(`  ${STRONG}`)).toMatch(/whitespace/);
    expect(bootstrapPasswordProblem(guessable)).toMatch(/guessable/);

    try {
      requireBootstrapPassword({ X: guessable }, 'X');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapPasswordRefused);
      expect((error as Error).message).toContain('X ');
      expect((error as Error).message).not.toContain(guessable);
    }
  });

  it('accepts a generated value', () => {
    expect(bootstrapPasswordProblem(STRONG)).toBeNull();
    expect(requireBootstrapPassword({ X: STRONG }, 'X')).toBe(STRONG);
  });
});
