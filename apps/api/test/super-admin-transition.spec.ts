import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
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
  passwordFor,
  planPromote,
  planRollback,
  TransitionRefused,
  type Manifest,
} from '../src/scripts/super-admin-transition';
import {
  applyKeys,
  NoTerminal,
  promptNewPassword,
  refusePasswordEnvironment,
  SecretEntryRefused,
  terminalSecretReader,
  type KeyState,
  type SecretReader,
} from '../src/scripts/terminal-secret';
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

/** A reader that answers each prompt in turn and records what it was asked. */
function scripted(...answers: string[]): SecretReader & { prompts: string[] } {
  const prompts: string[] = [];
  const reader = async (prompt: string) => {
    prompts.push(prompt);
    if (answers.length === 0) throw new Error('asked more often than scripted');
    return answers.shift()!;
  };
  return Object.assign(reader, { prompts });
}

function refusalOf(run: () => Promise<unknown>): Promise<Error> {
  return run().then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: Error) => error,
  );
}

describe('hidden password entry', () => {
  it('asks twice and returns a value that matches and passes the bootstrap rule', async () => {
    const reader = scripted(STRONG, STRONG);
    expect(await promptNewPassword(reader, 'new super admin password')).toBe(STRONG);
    expect(reader.prompts).toHaveLength(2);
    expect(reader.prompts.join(' ')).not.toContain(STRONG);
  });

  it('refuses two entries that differ, without repeating either', async () => {
    const other = generateFixturePassword();
    const error = await refusalOf(() => promptNewPassword(scripted(STRONG, other), 'new super admin password'));
    expect(error).toBeInstanceOf(SecretEntryRefused);
    expect(error.message).toMatch(/do not match/);
    expect(error.message).not.toContain(STRONG);
    expect(error.message).not.toContain(other);
  });

  it('refuses a weak value at the first entry, by the same rule as the seed, without repeating it', async () => {
    const weak = `Sifre-${'Taktic'}-Panel-2026-xyz`;
    const reader = scripted(weak, weak);
    const error = await refusalOf(() => promptNewPassword(reader, 'recovery password'));
    expect(error).toBeInstanceOf(SecretEntryRefused);
    expect(error.message).toMatch(/guessable/);
    expect(error.message).not.toContain(weak);
    expect(reader.prompts).toHaveLength(1);

    expect((await refusalOf(() => promptNewPassword(scripted(''), 'recovery password'))).message).toMatch(/is not set/);
    expect((await refusalOf(() => promptNewPassword(scripted('Kisa1!'), 'recovery password'))).message).toMatch(/shorter/);
  });

  it('refuses a password left in the environment, set or empty, naming the variable and never the value', () => {
    expect(() => refusePasswordEnvironment({})).not.toThrow();
    for (const name of ['SUPER_ADMIN_NEW_PASSWORD', 'SUPER_ADMIN_RECOVERY_PASSWORD']) {
      for (const value of [STRONG, '']) {
        try {
          refusePasswordEnvironment({ [name]: value });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(SecretEntryRefused);
          expect((error as Error).message).toContain(name);
          if (value) expect((error as Error).message).not.toContain(value);
        }
      }
    }
  });

  it('refuses to read without a terminal: none to open, or one that is not a TTY', async () => {
    const noDevice = terminalSecretReader(() => {
      throw Object.assign(new Error('ENXIO: no such device or address'), { code: 'ENXIO' });
    });
    expect(await refusalOf(() => noDevice('password: '))).toBeInstanceOf(NoTerminal);

    const notATerminal = terminalSecretReader(() => openSync('/dev/null', 'r+'));
    const error = await refusalOf(() => notATerminal('password: '));
    expect(error).toBeInstanceOf(NoTerminal);
    expect(error.message).toMatch(/without -T/);
  });

  it('reads keys without echo: Backspace edits, Enter ends, Ctrl-C and control keys refuse', () => {
    const state: KeyState = { chars: [] };
    expect(applyKeys(state, 'abX')).toBe('more');
    expect(applyKeys(state, '\u007fc')).toBe('more');
    expect(applyKeys(state, 'ş\rignored')).toBe('done');
    expect(state.chars.join('')).toBe('abcş');

    expect(applyKeys({ chars: [] }, 'ab\u0003')).toBe('cancelled');
    expect(applyKeys({ chars: [] }, '\u0004')).toBe('cancelled');
    expect(applyKeys({ chars: [] }, 'ab\u001b[A')).toBe('control');
    expect(applyKeys({ chars: [] }, '\t')).toBe('control');
  });

  it('asks only for the commands that set a password — dry runs included — and refuses a leftover variable first', async () => {
    const rename = parseArgs(['rename', '--from-id', 'x', '--to', TARGET, '--confirm-to', TARGET]);
    expect(await passwordFor(rename, scripted(STRONG, STRONG), {})).toBe(STRONG);
    expect(rename.apply).toBe(false);

    const keep = scripted();
    expect(await passwordFor({ ...rename, keepPassword: true }, keep, {})).toBeNull();
    expect(keep.prompts).toHaveLength(0);

    const recover = parseArgs(['recover-password', '--user-id', 'x']);
    expect(await passwordFor(recover, scripted(STRONG, STRONG), {})).toBe(STRONG);

    const inspectOnly = scripted();
    expect(await passwordFor(parseArgs(['inspect', '--to', TARGET]), inspectOnly, {})).toBeNull();
    expect(inspectOnly.prompts).toHaveLength(0);

    const untouched = scripted(STRONG, STRONG);
    await expect(passwordFor(rename, untouched, { SUPER_ADMIN_NEW_PASSWORD: STRONG })).rejects.toBeInstanceOf(SecretEntryRefused);
    expect(untouched.prompts).toHaveLength(0);
  });

  it('as a command with no controlling terminal, stops before the database and ignores a password piped to stdin', async () => {
    const old = await seedSuperAdmin();
    const apiRoot = join(__dirname, '..');
    // `detached` starts a new session: no controlling terminal, as under
    // `docker compose run -T` or cron.
    const env = { ...process.env };
    delete env.SUPER_ADMIN_NEW_PASSWORD;
    delete env.SUPER_ADMIN_RECOVERY_PASSWORD;
    const child = spawn(
      join(apiRoot, 'node_modules', '.bin', 'tsx'),
      ['src/scripts/super-admin-transition.ts', 'rename', '--from-id', old.id, '--to', TARGET, '--confirm-to', TARGET, '--apply'],
      { cwd: apiRoot, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.stdin.end(`${STRONG}\n${STRONG}\n`);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

    expect(code).toBe(2);
    expect(output).toMatch(/no terminal to read the password from/);
    expect(output).not.toContain(STRONG);
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ email: 'admin@taktic.local' });
  }, 60_000);
});
