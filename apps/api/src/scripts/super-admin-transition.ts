import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { NoTerminal, promptNewPassword, refusePasswordEnvironment, SecretEntryRefused, terminalSecretReader, type SecretReader } from './terminal-secret';

/**
 * Moves the platform's super-admin authority to a named address without ever
 * leaving it with no super admin who can sign in (STG-003).
 *
 *   pnpm --filter @taktic/api super-admin:transition -- inspect --to EMAIL
 *       read-only: every super admin, the target and which path applies
 *
 *   Path A — an account with the target address exists (a staff ADMIN):
 *     promote --to EMAIL --confirm-to EMAIL [--apply]
 *         the ADMIN becomes SUPER_ADMIN. Refused until the address is proven
 *         (`emailVerifiedAt`: the owner completes "Şifremi unuttum" for it).
 *         The old super admin is untouched, so there are two for a while.
 *     retire --from-id ID --to EMAIL [--promotion-manifest FILE] [--apply]
 *         the old super admin becomes an inactive ADMIN. Refused until the new
 *         one has signed in since its promotion — proof the new access works.
 *
 *   Path B — no account has the target address:
 *     rename --from-id ID --to EMAIL --confirm-to EMAIL [--apply] [--keep-password]
 *         the existing super admin takes the target address. Its password is
 *         rotated in the same transaction to one typed twice at a hidden
 *         prompt, so a password that was ever published stops working while
 *         whoever ran this keeps access. The address is then unproven until the owner
 *         completes "Şifremi unuttum" for it.
 *
 *   recover-password --user-id ID [--apply]
 *       break-glass: sets an active super admin's password, typed twice at a
 *       hidden prompt, for when nobody can sign in and mail cannot deliver a
 *       reset link.
 *   rollback --manifest FILE [--apply]
 *       undoes a promote, retire or rename from its applied manifest, only
 *       while every row is still exactly as that manifest left it.
 *
 * Every command is a dry run unless --apply is given: it reads in a READ ONLY
 * transaction, prints the plan and any refusal, and changes nothing. --apply
 * runs in one SERIALIZABLE transaction whose writes are each guarded by the
 * state the plan read and must touch exactly one row; before commit the table
 * must still hold an active SUPER_ADMIN with a password. Any miss rolls the
 * whole step back.
 *
 * Sessions: every account whose authority or address changes has all of its
 * sessions revoked in the same transaction, along with its open reset and
 * verification links, so nothing issued under the old state survives it.
 *
 * Passwords are read only from the controlling terminal (/dev/tty, echo off),
 * twice, and judged by the bootstrap rule — dry runs included, so a dry run
 * proves the value too. Never from an argument or the environment: a
 * SUPER_ADMIN_NEW_PASSWORD / SUPER_ADMIN_RECOVERY_PASSWORD still set is
 * refused, and with no terminal (`docker compose run -T`, a pipe) the command
 * stops before reading the database.
 *
 * Output never contains a password, a hash or a token. Addresses are masked on
 * the console; the applied manifest — which rollback needs and which carries
 * the full addresses — is written outside the repository into --out,
 * $TAKTIC_OPS_OUTPUT_DIR or ~/Backups/taktic/ops, with mode 0600.
 *
 * What it will not do: turn a customer or provider account into an operator
 * account (one address, one kind of account — that needs a person), promote
 * an address nobody has proven, or run a step that would leave no super admin.
 */

/** How recent the new super admin's sign-in must be for `retire`. */
export const RETIRE_SIGN_IN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The cost factor every other password in this product is stored at. */
const PASSWORD_HASH_ROUNDS = 12;
const STAFF_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN, UserRole.ADMIN];

type Tx = Prisma.TransactionClient;

export class TransitionRefused extends Error {
  constructor(readonly refusals: string[]) {
    super(`super-admin-transition: refused — ${refusals.join('; ')}`);
  }
}

/** A guarded write found the row changed under it, or the end state was wrong. */
export class TransitionAborted extends Error {}

export function normalizeEmail(value: string | undefined | null): string | null {
  const folded = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(folded) ? folded : null;
}

/** `u***@icloud.com` — enough to recognise, not enough to harvest. */
export function maskEmail(email: string | null): string {
  if (!email) return '(none)';
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

const accountSelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  emailVerifiedAt: true,
  passwordHash: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type AccountRow = Prisma.UserGetPayload<{ select: typeof accountSelect }>;

export type AccountSummary = {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  emailVerified: boolean;
  hasPassword: boolean;
  /** When its newest session was issued — a sign-in. (`User.lastLoginAt` is never written.) */
  lastSignInAt: string | null;
  liveSessions: number;
};

async function lastSignIn(tx: Tx, userId: string): Promise<Date | null> {
  const newest = await tx.session.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return newest?.createdAt ?? null;
}

async function summarize(tx: Tx, row: AccountRow, now: Date): Promise<AccountSummary> {
  const liveSessions = await tx.session.count({
    where: { userId: row.id, revokedAt: null, expiresAt: { gt: now } },
  });
  return {
    id: row.id,
    email: maskEmail(row.email),
    role: row.role,
    isActive: row.isActive,
    emailVerified: row.emailVerifiedAt !== null,
    hasPassword: row.passwordHash !== null,
    lastSignInAt: (await lastSignIn(tx, row.id))?.toISOString() ?? null,
    liveSessions,
  };
}

/** Active super admins that can sign in: the invariant every step preserves. */
async function usableSuperAdminCount(tx: Tx): Promise<number> {
  return tx.user.count({ where: { role: UserRole.SUPER_ADMIN, isActive: true, passwordHash: { not: null } } });
}

async function assertSuperAdminRemains(tx: Tx): Promise<void> {
  if ((await usableSuperAdminCount(tx)) < 1) {
    throw new TransitionAborted('this step would leave no active super admin with a password; rolled back');
  }
}

/** Revokes every live session and spends every open link of one account. */
async function closeEverythingIssuedTo(tx: Tx, userId: string, now: Date): Promise<number> {
  const sessions = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  await tx.emailVerificationToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  return sessions.count;
}

function exactlyOne(count: number, what: string): void {
  if (count !== 1) {
    throw new TransitionAborted(`${what}: expected to change exactly one row, changed ${count}; the account moved under this run — rolled back`);
  }
}

// ── inspect ─────────────────────────────────────────────────────────────────

export type TargetState =
  | { kind: 'absent' }
  | {
      kind: 'present';
      account: AccountSummary;
      /** Marketplace history the account carries, which no role change may orphan. */
      relations: { serviceRequests: number; providerProfile: boolean; liveRoleAssignments: number };
    };

export type Inspection = {
  superAdmins: AccountSummary[];
  usableSuperAdmins: number;
  target: TargetState;
  path: 'A-promote' | 'A-retire' | 'B-rename' | 'refused';
  notes: string[];
};

export async function inspect(tx: Tx, targetEmail: string, now = new Date()): Promise<Inspection> {
  const superAdminRows = await tx.user.findMany({
    where: { role: UserRole.SUPER_ADMIN },
    select: accountSelect,
    orderBy: { createdAt: 'asc' },
  });
  const superAdmins = await Promise.all(superAdminRows.map((row) => summarize(tx, row, now)));
  const usableSuperAdmins = await usableSuperAdminCount(tx);
  const targetRow = await tx.user.findUnique({ where: { email: targetEmail }, select: accountSelect });
  const notes: string[] = [];

  if (!targetRow) {
    notes.push('no account has the target address: path B (rename an existing super admin)');
    return { superAdmins, usableSuperAdmins, target: { kind: 'absent' }, path: 'B-rename', notes };
  }

  const [serviceRequests, providerProfile, liveRoleAssignments] = await Promise.all([
    tx.serviceRequest.count({ where: { customerId: targetRow.id } }),
    tx.providerProfile.findUnique({ where: { userId: targetRow.id }, select: { id: true } }),
    tx.adminRoleAssignment.count({ where: { userId: targetRow.id, revokedAt: null } }),
  ]);
  const target: TargetState = {
    kind: 'present',
    account: await summarize(tx, targetRow, now),
    relations: { serviceRequests, providerProfile: providerProfile !== null, liveRoleAssignments },
  };

  if (!STAFF_ROLES.includes(targetRow.role)) {
    notes.push(
      `the target address belongs to a ${targetRow.role} account; a marketplace account is never turned into an operator account — a person decides (see the runbook)`,
    );
    return { superAdmins, usableSuperAdmins, target, path: 'refused', notes };
  }
  if (targetRow.role === UserRole.SUPER_ADMIN) {
    notes.push('the target is already a super admin: what is left is retiring any old one (retire)');
    if (!targetRow.emailVerifiedAt) {
      notes.push('its address is not proven yet: the owner completes "Şifremi unuttum" for it — until then the hand-over is not finished');
    }
    return { superAdmins, usableSuperAdmins, target, path: 'A-retire', notes };
  }
  notes.push('the target is a staff ADMIN: path A (promote, then retire the old super admin)');
  if (!targetRow.emailVerifiedAt) {
    notes.push('its address is not proven yet: the owner completes "Şifremi unuttum" for it before promote');
  }
  return { superAdmins, usableSuperAdmins, target, path: 'A-promote', notes };
}

// ── manifests ───────────────────────────────────────────────────────────────

export type PromoteManifest = {
  version: 1;
  action: 'promote';
  appliedAt: string;
  userId: string;
  email: string;
  before: { role: UserRole };
  after: { role: UserRole };
  sessionsRevoked: number;
};

export type RetireManifest = {
  version: 1;
  action: 'retire';
  appliedAt: string;
  userId: string;
  successorId: string;
  before: { role: UserRole; isActive: boolean };
  after: { role: UserRole; isActive: boolean };
  sessionsRevoked: number;
};

export type RenameManifest = {
  version: 1;
  action: 'rename';
  appliedAt: string;
  userId: string;
  before: { email: string; emailVerifiedAt: string | null };
  after: { email: string; emailVerifiedAt: null };
  /** Whether the password was rotated. The old hash is not kept: it is never restored. */
  passwordRotated: boolean;
  sessionsRevoked: number;
};

export type RecoverManifest = {
  version: 1;
  action: 'recover-password';
  appliedAt: string;
  userId: string;
  sessionsRevoked: number;
};

export type Manifest = PromoteManifest | RetireManifest | RenameManifest | RecoverManifest;

export function parseManifest(text: string): Manifest {
  const parsed = JSON.parse(text) as Partial<Manifest>;
  if (parsed?.version !== 1 || typeof parsed.userId !== 'string' || typeof parsed.appliedAt !== 'string') {
    throw new Error('not a super-admin-transition manifest (version 1)');
  }
  if (!['promote', 'retire', 'rename', 'recover-password'].includes(String(parsed.action))) {
    throw new Error(`unknown manifest action: ${String(parsed.action)}`);
  }
  return parsed as Manifest;
}

// ── promote (path A, step 1) ────────────────────────────────────────────────

async function promoteRefusals(tx: Tx, targetEmail: string): Promise<{ refusals: string[]; target: AccountRow | null }> {
  const target = await tx.user.findUnique({ where: { email: targetEmail }, select: accountSelect });
  const refusals: string[] = [];
  if (!target) {
    refusals.push('no account has the target address; this is path B (rename)');
  } else if (target.role === UserRole.SUPER_ADMIN) {
    refusals.push('the target is already a super admin; nothing to promote — continue with retire');
  } else if (target.role !== UserRole.ADMIN) {
    refusals.push(`the target is a ${target.role} account; only a staff ADMIN account is promoted`);
  } else {
    if (!target.isActive) refusals.push('the target account is inactive');
    if (!target.passwordHash) refusals.push('the target account has no password (its invite was never completed)');
    if (!target.emailVerifiedAt) {
      refusals.push('the target address is not proven: its owner must complete "Şifremi unuttum" for it first');
    }
  }
  return { refusals, target };
}

export async function planPromote(tx: Tx, targetEmail: string): Promise<string[]> {
  return (await promoteRefusals(tx, targetEmail)).refusals;
}

export async function applyPromote(tx: Tx, targetEmail: string, now = new Date()): Promise<PromoteManifest> {
  const { refusals, target } = await promoteRefusals(tx, targetEmail);
  if (refusals.length > 0 || !target) throw new TransitionRefused(refusals);

  const changed = await tx.user.updateMany({
    where: {
      id: target.id,
      role: UserRole.ADMIN,
      isActive: true,
      passwordHash: { not: null },
      emailVerifiedAt: { not: null },
    },
    data: { role: UserRole.SUPER_ADMIN },
  });
  exactlyOne(changed.count, 'promote');
  // The account's sessions were issued to an ADMIN; the next one is issued to
  // what it is now.
  const sessionsRevoked = await closeEverythingIssuedTo(tx, target.id, now);
  await assertSuperAdminRemains(tx);

  return {
    version: 1,
    action: 'promote',
    appliedAt: now.toISOString(),
    userId: target.id,
    email: targetEmail,
    before: { role: UserRole.ADMIN },
    after: { role: UserRole.SUPER_ADMIN },
    sessionsRevoked,
  };
}

// ── retire (path A, step 2) ─────────────────────────────────────────────────

export type RetireInput = {
  fromId: string;
  targetEmail: string;
  /** The promotion's time, from its manifest; the new sign-in must be later. */
  promotedAt: Date | null;
};

async function retireRefusals(tx: Tx, input: RetireInput, now: Date) {
  const refusals: string[] = [];
  const source = await tx.user.findUnique({ where: { id: input.fromId }, select: accountSelect });
  const successor = await tx.user.findUnique({ where: { email: input.targetEmail }, select: accountSelect });

  if (!source) refusals.push('no account has the --from-id');
  else {
    if (source.role !== UserRole.SUPER_ADMIN) refusals.push(`the --from-id account is ${source.role}, not a super admin`);
    if (!source.isActive) refusals.push('the --from-id account is already inactive');
  }
  if (!successor) refusals.push('no account has the target address');
  else {
    if (source && successor.id === source.id) refusals.push('the account to retire is the successor itself');
    if (successor.role !== UserRole.SUPER_ADMIN) refusals.push('the successor is not a super admin yet — promote first');
    if (!successor.isActive) refusals.push('the successor is inactive');
    if (!successor.passwordHash) refusals.push('the successor has no password');
    if (!successor.emailVerifiedAt) refusals.push('the successor address is not proven');
    // The new access has to have been used, not merely granted: a promotion
    // nobody has signed in with is not yet a super admin anybody has.
    const since = new Date(Math.max(now.getTime() - RETIRE_SIGN_IN_WINDOW_MS, input.promotedAt?.getTime() ?? 0));
    const signedInAt = await lastSignIn(tx, successor.id);
    if (!signedInAt || signedInAt <= since) {
      refusals.push(
        `the successor has not signed in since ${since.toISOString()}: sign in to the admin panel with it first`,
      );
    }
  }
  return { refusals, source, successor };
}

export async function planRetire(tx: Tx, input: RetireInput, now = new Date()): Promise<string[]> {
  return (await retireRefusals(tx, input, now)).refusals;
}

export async function applyRetire(tx: Tx, input: RetireInput, now = new Date()): Promise<RetireManifest> {
  const { refusals, source, successor } = await retireRefusals(tx, input, now);
  if (refusals.length > 0 || !source || !successor) throw new TransitionRefused(refusals);

  // Both facts at once: no super-admin authority, and no sign-in at all. An
  // ADMIN with no role assignment could do nothing anyway; inactive closes
  // the door before the panel is reached.
  const changed = await tx.user.updateMany({
    where: { id: source.id, role: UserRole.SUPER_ADMIN, isActive: true },
    data: { role: UserRole.ADMIN, isActive: false },
  });
  exactlyOne(changed.count, 'retire');
  await tx.accountStatusChange.create({
    data: {
      userId: source.id,
      userRole: UserRole.SUPER_ADMIN,
      fromActive: true,
      toActive: false,
      reason: 'STG-003: süper yönetici yetkisi devredildi (super-admin-transition retire)',
      actorId: successor.id,
    },
    select: { id: true },
  });
  const sessionsRevoked = await closeEverythingIssuedTo(tx, source.id, now);
  await assertSuperAdminRemains(tx);

  return {
    version: 1,
    action: 'retire',
    appliedAt: now.toISOString(),
    userId: source.id,
    successorId: successor.id,
    before: { role: UserRole.SUPER_ADMIN, isActive: true },
    after: { role: UserRole.ADMIN, isActive: false },
    sessionsRevoked,
  };
}

// ── rename (path B) ─────────────────────────────────────────────────────────

export type RenameInput = {
  fromId: string;
  targetEmail: string;
  /** The new password, already judged by the bootstrap rule; null keeps the current one. */
  newPassword: string | null;
};

async function renameRefusals(tx: Tx, input: RenameInput) {
  const refusals: string[] = [];
  const source = await tx.user.findUnique({ where: { id: input.fromId }, select: accountSelect });
  const holder = await tx.user.findUnique({ where: { email: input.targetEmail }, select: { id: true, role: true } });
  if (holder) {
    refusals.push(`the target address is already held by a ${holder.role} account; this is path A, or a person decides`);
  }
  if (!source) refusals.push('no account has the --from-id');
  else {
    if (source.role !== UserRole.SUPER_ADMIN) refusals.push(`the --from-id account is ${source.role}, not a super admin`);
    if (!source.isActive) refusals.push('the --from-id account is inactive');
    if (!source.passwordHash && !input.newPassword) refusals.push('the account has no password and none is being set');
  }
  return { refusals, source };
}

export async function planRename(tx: Tx, input: RenameInput): Promise<string[]> {
  return (await renameRefusals(tx, input)).refusals;
}

export async function applyRename(tx: Tx, input: RenameInput, now = new Date()): Promise<RenameManifest> {
  const { refusals, source } = await renameRefusals(tx, input);
  if (refusals.length > 0 || !source?.email) {
    throw new TransitionRefused(refusals.length > 0 ? refusals : ['the account has no address to record for rollback']);
  }

  const passwordHash = input.newPassword ? await bcrypt.hash(input.newPassword, PASSWORD_HASH_ROUNDS) : undefined;
  // `emailVerifiedAt` goes with the old address: the proof was for it, and the
  // new one earns its own when its owner completes a reset link.
  const changed = await tx.user.updateMany({
    where: { id: source.id, role: UserRole.SUPER_ADMIN, isActive: true, email: source.email },
    data: { email: input.targetEmail, emailVerifiedAt: null, ...(passwordHash ? { passwordHash } : {}) },
  });
  exactlyOne(changed.count, 'rename');
  // Every session and link was issued to the old address; none outlives it.
  const sessionsRevoked = await closeEverythingIssuedTo(tx, source.id, now);
  await assertSuperAdminRemains(tx);

  return {
    version: 1,
    action: 'rename',
    appliedAt: now.toISOString(),
    userId: source.id,
    before: { email: source.email, emailVerifiedAt: source.emailVerifiedAt?.toISOString() ?? null },
    after: { email: input.targetEmail, emailVerifiedAt: null },
    passwordRotated: Boolean(passwordHash),
    sessionsRevoked,
  };
}

// ── recover-password (break-glass) ─────────────────────────────────────────

async function recoverRefusals(tx: Tx, userId: string) {
  const account = await tx.user.findUnique({ where: { id: userId }, select: accountSelect });
  const refusals: string[] = [];
  if (!account) refusals.push('no account has the --user-id');
  else {
    if (account.role !== UserRole.SUPER_ADMIN) refusals.push(`the account is ${account.role}; recovery is for a super admin`);
    if (!account.isActive) refusals.push('the account is inactive; roll its retire back instead');
  }
  return { refusals, account };
}

export async function planRecover(tx: Tx, userId: string): Promise<string[]> {
  return (await recoverRefusals(tx, userId)).refusals;
}

export async function applyRecover(tx: Tx, userId: string, password: string, now = new Date()): Promise<RecoverManifest> {
  const { refusals, account } = await recoverRefusals(tx, userId);
  if (refusals.length > 0 || !account) throw new TransitionRefused(refusals);

  const changed = await tx.user.updateMany({
    where: { id: account.id, role: UserRole.SUPER_ADMIN, isActive: true },
    data: { passwordHash: await bcrypt.hash(password, PASSWORD_HASH_ROUNDS) },
  });
  exactlyOne(changed.count, 'recover-password');
  const sessionsRevoked = await closeEverythingIssuedTo(tx, account.id, now);
  await assertSuperAdminRemains(tx);
  return { version: 1, action: 'recover-password', appliedAt: now.toISOString(), userId: account.id, sessionsRevoked };
}

// ── rollback ────────────────────────────────────────────────────────────────

export async function planRollback(tx: Tx, manifest: Manifest): Promise<string[]> {
  const refusals: string[] = [];
  const row = await tx.user.findUnique({ where: { id: manifest.userId }, select: accountSelect });
  if (!row) return ['the manifest account no longer exists'];

  if (manifest.action === 'promote') {
    if (row.role !== UserRole.SUPER_ADMIN) refusals.push('the promoted account is no longer a super admin');
    const others = await tx.user.count({
      where: { id: { not: row.id }, role: UserRole.SUPER_ADMIN, isActive: true, passwordHash: { not: null } },
    });
    if (others < 1) refusals.push('the promoted account is the only usable super admin; rolling back would leave none');
  } else if (manifest.action === 'retire') {
    if (row.role !== UserRole.ADMIN || row.isActive) refusals.push('the retired account is no longer an inactive ADMIN');
    if (!row.passwordHash) refusals.push('the retired account has no password to sign in with');
    const actor = await tx.user.findUnique({ where: { id: manifest.successorId }, select: { id: true } });
    if (!actor) refusals.push('the successor named in the manifest no longer exists');
  } else if (manifest.action === 'rename') {
    if (row.email !== manifest.after.email) refusals.push('the account no longer has the address the rename gave it');
    const holder = await tx.user.findUnique({ where: { email: manifest.before.email }, select: { id: true } });
    if (holder) refusals.push('the old address is held by another account now');
  } else {
    refusals.push('a password recovery is not rolled back: set the password again, or reset it by mail');
  }
  return refusals;
}

export async function applyRollback(tx: Tx, manifest: Manifest, now = new Date()): Promise<{ action: string; userId: string; sessionsRevoked: number }> {
  const refusals = await planRollback(tx, manifest);
  if (refusals.length > 0) throw new TransitionRefused(refusals);

  if (manifest.action === 'promote') {
    const changed = await tx.user.updateMany({
      where: { id: manifest.userId, role: UserRole.SUPER_ADMIN },
      data: { role: manifest.before.role },
    });
    exactlyOne(changed.count, 'rollback promote');
  } else if (manifest.action === 'retire') {
    const changed = await tx.user.updateMany({
      where: { id: manifest.userId, role: UserRole.ADMIN, isActive: false },
      data: { role: manifest.before.role, isActive: manifest.before.isActive },
    });
    exactlyOne(changed.count, 'rollback retire');
    await tx.accountStatusChange.create({
      data: {
        userId: manifest.userId,
        userRole: manifest.before.role,
        fromActive: false,
        toActive: true,
        reason: 'STG-003: süper yönetici devri geri alındı (super-admin-transition rollback)',
        actorId: manifest.successorId,
      },
      select: { id: true },
    });
  } else if (manifest.action === 'rename') {
    const changed = await tx.user.updateMany({
      where: { id: manifest.userId, email: manifest.after.email },
      data: {
        email: manifest.before.email,
        emailVerifiedAt: manifest.before.emailVerifiedAt ? new Date(manifest.before.emailVerifiedAt) : null,
      },
    });
    exactlyOne(changed.count, 'rollback rename');
  }
  const sessionsRevoked = await closeEverythingIssuedTo(tx, manifest.userId, now);
  await assertSuperAdminRemains(tx);
  return { action: `rollback ${manifest.action}`, userId: manifest.userId, sessionsRevoked };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

type Command = 'inspect' | 'promote' | 'retire' | 'rename' | 'recover-password' | 'rollback';

export type Cli = {
  command: Command;
  apply: boolean;
  to: string | null;
  confirmTo: string | null;
  fromId: string | null;
  userId: string | null;
  manifest: string | null;
  promotionManifest: string | null;
  keepPassword: boolean;
  out: string;
};

const COMMANDS: readonly Command[] = ['inspect', 'promote', 'retire', 'rename', 'recover-password', 'rollback'];

export function parseArgs(argv: string[]): Cli {
  const args = argv.filter((arg) => arg !== '--');
  const command = args.shift() as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error(`first argument must be one of: ${COMMANDS.join(', ')}`);
  }
  const cli: Cli = {
    command,
    apply: false,
    to: null,
    confirmTo: null,
    fromId: null,
    userId: null,
    manifest: null,
    promotionManifest: null,
    keepPassword: false,
    out: process.env.TAKTIC_OPS_OUTPUT_DIR || join(homedir(), 'Backups', 'taktic', 'ops'),
  };
  const value = (flag: string, index: number): string => {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') cli.apply = true;
    else if (arg === '--keep-password') cli.keepPassword = true;
    else if (arg === '--to') cli.to = normalizeEmail(value(arg, i++));
    else if (arg === '--confirm-to') cli.confirmTo = normalizeEmail(value(arg, i++));
    else if (arg === '--from-id') cli.fromId = value(arg, i++);
    else if (arg === '--user-id') cli.userId = value(arg, i++);
    else if (arg === '--manifest') cli.manifest = value(arg, i++);
    else if (arg === '--promotion-manifest') cli.promotionManifest = value(arg, i++);
    else if (arg === '--out') cli.out = value(arg, i++);
    else throw new Error(`unknown argument: ${arg}`);
  }

  const needsTo: Command[] = ['inspect', 'promote', 'retire', 'rename'];
  if (needsTo.includes(command) && !cli.to) throw new Error(`${command} needs --to with a valid address`);
  // The two commands that point authority at an address ask for it twice: a
  // typo here would hand the reset link — and with it the account — to
  // whoever owns the misspelt mailbox.
  if ((command === 'promote' || command === 'rename') && cli.confirmTo !== cli.to) {
    throw new Error(`${command} needs --confirm-to repeating --to exactly`);
  }
  if ((command === 'retire' || command === 'rename') && !cli.fromId) throw new Error(`${command} needs --from-id`);
  if (command === 'recover-password' && !cli.userId) throw new Error('recover-password needs --user-id');
  if (command === 'rollback' && !cli.manifest) throw new Error('rollback needs --manifest');
  if (cli.keepPassword && command !== 'rename') throw new Error('--keep-password applies to rename only');
  if (command === 'inspect' && cli.apply) throw new Error('inspect only reads; it takes no --apply');
  return cli;
}

function writePrivate(dir: string, name: string, body: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function printAccount(prefix: string, account: AccountSummary): void {
  console.log(
    `${prefix}${account.id} ${account.email} role=${account.role} active=${account.isActive} ` +
      `emailVerified=${account.emailVerified} password=${account.hasPassword ? 'set' : 'none'} ` +
      `lastSignIn=${account.lastSignInAt ?? 'never'} liveSessions=${account.liveSessions}`,
  );
}

function printInspection(result: Inspection): void {
  console.log(`super admins             : ${result.superAdmins.length} (usable: active with a password = ${result.usableSuperAdmins})`);
  for (const account of result.superAdmins) printAccount('  ', account);
  if (result.target.kind === 'absent') {
    console.log('target                   : no account');
  } else {
    printAccount('target                   : ', result.target.account);
    const { serviceRequests, providerProfile, liveRoleAssignments } = result.target.relations;
    console.log(`  relations              : serviceRequests=${serviceRequests} providerProfile=${providerProfile} liveRoleAssignments=${liveRoleAssignments}`);
  }
  console.log(`path                     : ${result.path}`);
  for (const note of result.notes) console.log(`  - ${note}`);
}

function printManifest(manifest: Manifest): void {
  const safe: Record<string, unknown> = { ...manifest };
  if (manifest.action === 'promote') safe.email = maskEmail(manifest.email);
  if (manifest.action === 'rename') {
    safe.before = { ...manifest.before, email: maskEmail(manifest.before.email) };
    safe.after = { ...manifest.after, email: maskEmail(manifest.after.email) };
  }
  console.log(JSON.stringify(safe, null, 2));
}

async function readOnly<T>(prisma: PrismaClient, run: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // A dry run cannot write, whatever a future edit to this file does.
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return run(tx);
  });
}

function serializable<T>(prisma: PrismaClient, run: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 });
}

/**
 * The password a command sets, asked for before any transaction opens (the
 * person may take a while; a SERIALIZABLE transaction should not wait on
 * them). Null when the command sets none.
 */
export async function passwordFor(cli: Cli, read: SecretReader, env: NodeJS.ProcessEnv): Promise<string | null> {
  refusePasswordEnvironment(env);
  if (cli.command === 'rename' && !cli.keepPassword) return promptNewPassword(read, 'new super admin password');
  if (cli.command === 'recover-password') return promptNewPassword(read, 'recovery password');
  return null;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  // Before the database is touched: a refused entry or a missing terminal
  // ends the run with nothing read and nothing changed.
  let password: string | null;
  const terminal = terminalSecretReader();
  try {
    password = await passwordFor(cli, terminal, process.env);
  } catch (error) {
    if (error instanceof SecretEntryRefused || error instanceof NoTerminal) {
      console.error(`super-admin-transition: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    // Back to the terminal's own mode before anything else is printed.
    terminal.close();
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prisma = new PrismaClient();
  const banner = (what: string) => console.log(`\n=== SUPER ADMIN TRANSITION — ${cli.command.toUpperCase()} — ${what} ===\n`);
  const refused = (refusals: string[]) => {
    console.log('refusals:');
    for (const refusal of refusals) console.log(`  - ${refusal}`);
    process.exitCode = 2;
  };

  try {
    if (cli.command === 'inspect') {
      banner('READ ONLY');
      printInspection(await readOnly(prisma, (tx) => inspect(tx, cli.to!)));
      return;
    }

    const promotedAt = cli.promotionManifest
      ? (() => {
          const manifest = parseManifest(readFileSync(cli.promotionManifest!, 'utf8'));
          if (manifest.action !== 'promote') throw new Error('--promotion-manifest must be a promote manifest');
          return new Date(manifest.appliedAt);
        })()
      : null;
    const rollbackManifest = cli.manifest ? parseManifest(readFileSync(cli.manifest, 'utf8')) : null;

    const newPassword = cli.command === 'rename' ? password : null;
    const recoveryPassword = cli.command === 'recover-password' ? password : null;

    const plan = (tx: Tx): Promise<string[]> => {
      switch (cli.command) {
        case 'promote':
          return planPromote(tx, cli.to!);
        case 'retire':
          return planRetire(tx, { fromId: cli.fromId!, targetEmail: cli.to!, promotedAt });
        case 'rename':
          return planRename(tx, { fromId: cli.fromId!, targetEmail: cli.to!, newPassword });
        case 'recover-password':
          return planRecover(tx, cli.userId!);
        default:
          return planRollback(tx, rollbackManifest!);
      }
    };

    if (!cli.apply) {
      banner('DRY RUN (nothing changed)');
      const refusals = await readOnly(prisma, plan);
      if (password) console.log('password                 : typed twice, matches, passes the bootstrap rule (not shown)');
      if (refusals.length > 0) refused(refusals);
      else console.log('no refusals: --apply would run this step');
      return;
    }

    const result = await serializable(prisma, (tx): Promise<Manifest | { action: string; userId: string; sessionsRevoked: number }> => {
      switch (cli.command) {
        case 'promote':
          return applyPromote(tx, cli.to!);
        case 'retire':
          return applyRetire(tx, { fromId: cli.fromId!, targetEmail: cli.to!, promotedAt });
        case 'rename':
          return applyRename(tx, { fromId: cli.fromId!, targetEmail: cli.to!, newPassword });
        case 'recover-password':
          return applyRecover(tx, cli.userId!, recoveryPassword!);
        default:
          return applyRollback(tx, rollbackManifest!);
      }
    });
    banner('APPLIED');
    if ('version' in result) {
      printManifest(result);
      const file = writePrivate(cli.out, `super-admin-transition-${stamp}-${result.action}.json`, result);
      console.log(`\nmanifest written to ${file} (mode 0600; rollback reads it)`);
    } else {
      console.log(JSON.stringify(result, null, 2));
      writePrivate(cli.out, `super-admin-transition-${stamp}-rollback.json`, { ...result, appliedAt: new Date().toISOString() });
    }
  } catch (error) {
    if (error instanceof TransitionRefused) {
      banner('REFUSED (nothing changed)');
      refused(error.refusals);
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// realpath on both sides: macOS reaches the temp directory through a symlink,
// and a test importing this module must not run it.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(__filename);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
