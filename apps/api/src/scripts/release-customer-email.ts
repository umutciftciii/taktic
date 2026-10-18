import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CustomerOrigin, Prisma, PrismaClient, UserRole } from '@prisma/client';
import { isReleasedEmail, releasedCustomerEmail } from '../common/released-customer-email';

/**
 * Frees one address held by a customer account nobody ever claimed, so that a
 * different account can take it (STG-003B — the super-admin hand-over finds
 * its target address on such an account).
 *
 *   pnpm --filter @taktic/api customer-email:release -- inspect --user-id ID --email EMAIL
 *       read-only: the account, why it may or may not be released, its relations
 *   release --user-id ID --email EMAIL --confirm-email EMAIL [--apply] [--out DIR]
 *       the account's address becomes `released-<id>@account.invalid`
 *   rollback --manifest FILE [--apply]
 *       gives the account its address back from the applied manifest, only
 *       while nobody else holds that address and the account is untouched
 *
 * Only an account that was never anybody's is released: a CUSTOMER created by
 * a request (`AUTO_CREATED_REQUEST`) with no password and an unproven address.
 * The account is named twice — by id and by the address it holds now — so a
 * typo in either refuses the run instead of releasing somebody else.
 *
 * What changes, in one SERIALIZABLE transaction, every write guarded by the
 * state the plan read:
 *   - User.email → the placeholder; emailVerifiedAt stays NULL;
 *   - every open activation, reset and verification link of the account is
 *     spent, and every session revoked: a link mailed to the old address must
 *     never sign anybody into this account again.
 * Nothing else. The account, its requests, offers, credits, messages and
 * every other row pointing at it stay exactly as they were — the transaction
 * counts them before and after and rolls back on any difference — and each
 * request's `customerEmail` keeps the address it was submitted with, as the
 * historical snapshot it is. The notification dispatcher refuses any new mail
 * for a released account (RECIPIENT_RELEASED), so that snapshot is no longer
 * written to.
 *
 * Every command is a dry run unless --apply is given. The applied manifest
 * carries the old address (rollback needs it) and nothing secret; it is
 * written outside the repository into --out, $TAKTIC_OPS_OUTPUT_DIR or
 * ~/Backups/taktic/ops with mode 0600. The console only ever shows addresses
 * masked.
 */

type Tx = Prisma.TransactionClient;

export class ReleaseRefused extends Error {
  constructor(readonly refusals: string[]) {
    super(`release-customer-email: refused — ${refusals.join('; ')}`);
  }
}

/** A guarded write found the row changed under it, or the end state was wrong. */
export class ReleaseAborted extends Error {}

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
  customerOrigin: true,
  isActive: true,
  emailVerifiedAt: true,
  passwordHash: true,
} satisfies Prisma.UserSelect;

type AccountRow = Prisma.UserGetPayload<{ select: typeof accountSelect }>;

// ── relations: what must not change ─────────────────────────────────────────

/**
 * Every row in the database that points at the account, counted per foreign
 * key column — read from the catalog, so a relation added later is counted
 * without anybody remembering to list it here — plus a digest of the
 * account's requests (their snapshot address included). A release changes
 * none of it; the transaction compares the two readings before it commits.
 */
export type RelationFingerprint = {
  references: Record<string, number>;
  requestsDigest: string;
};

export async function relationFingerprint(tx: Tx, userId: string): Promise<RelationFingerprint> {
  const columns = await tx.$queryRaw<Array<{ tbl: string; col: string }>>`
    SELECT cl.relname AS tbl, a.attname AS col
      FROM pg_constraint k
      JOIN pg_class cl ON cl.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
     WHERE k.contype = 'f' AND k.confrelid = 'public."User"'::regclass AND n.nspname = 'public'
     ORDER BY 1, 2`;
  const references: Record<string, number> = {};
  for (const { tbl, col } of columns) {
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const [row] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM public.${quote(tbl)} WHERE ${quote(col)} = $1`,
      userId,
    );
    references[`${tbl}.${col}`] = Number(row?.n ?? 0);
  }
  const [digest] = await tx.$queryRaw<Array<{ d: string | null }>>`
    SELECT md5(coalesce(string_agg(
             concat_ws('|', r."id", r."status"::text, r."customerEmail", r."customerPhone", r."updatedAt"::text),
             ',' ORDER BY r."id"), '')) AS d
      FROM "ServiceRequest" r
     WHERE r."customerId" = ${userId}`;
  return { references, requestsDigest: digest?.d ?? '' };
}

/** Rows a release itself writes; their counts are allowed to change nowhere. */
function sameRelations(before: RelationFingerprint, after: RelationFingerprint): boolean {
  return (
    before.requestsDigest === after.requestsDigest &&
    JSON.stringify(before.references) === JSON.stringify(after.references)
  );
}

// ── inspect / plan ──────────────────────────────────────────────────────────

export type ReleaseInput = { userId: string; email: string };

export type Inspection = {
  account: {
    id: string;
    email: string;
    role: UserRole;
    customerOrigin: CustomerOrigin | null;
    isActive: boolean;
    emailVerified: boolean;
    hasPassword: boolean;
  } | null;
  placeholder: string;
  openLinks: { activation: number; passwordReset: number; emailVerification: number };
  liveSessions: number;
  relations: RelationFingerprint | null;
  refusals: string[];
};

function refusalsFor(account: AccountRow | null, input: ReleaseInput, placeholderHolder: { id: string } | null): string[] {
  const refusals: string[] = [];
  if (!account) {
    refusals.push('no account has the --user-id');
    return refusals;
  }
  if (isReleasedEmail(account.email)) {
    refusals.push('the account is already released');
    return refusals;
  }
  if (account.email !== input.email) {
    refusals.push('the account does not hold --email; nothing is released for an address it does not have');
  }
  if (account.role !== UserRole.CUSTOMER) refusals.push(`the account is ${account.role}, not a CUSTOMER`);
  if (account.customerOrigin !== CustomerOrigin.AUTO_CREATED_REQUEST) {
    refusals.push(`the account was not created by a request (origin ${account.customerOrigin ?? 'none'}); somebody owns it`);
  }
  if (account.passwordHash !== null) refusals.push('the account has a password; somebody claimed it');
  if (account.emailVerifiedAt !== null) refusals.push('the account has proven its address; it is somebody\'s');
  if (placeholderHolder && placeholderHolder.id !== account.id) {
    refusals.push('another account already holds the placeholder address');
  }
  return refusals;
}

async function readState(tx: Tx, input: ReleaseInput) {
  const account = await tx.user.findUnique({ where: { id: input.userId }, select: accountSelect });
  const placeholder = releasedCustomerEmail(input.userId);
  const placeholderHolder = await tx.user.findUnique({ where: { email: placeholder }, select: { id: true } });
  const providerProfile = account
    ? await tx.providerProfile.findUnique({ where: { userId: account.id }, select: { id: true } })
    : null;
  const liveRoleAssignments = account
    ? await tx.adminRoleAssignment.count({ where: { userId: account.id, revokedAt: null } })
    : 0;
  const refusals = refusalsFor(account, input, placeholderHolder);
  if (providerProfile) refusals.push('the account has a provider profile');
  if (liveRoleAssignments > 0) refusals.push('the account holds staff role assignments');
  return { account, placeholder, refusals };
}

export async function inspect(tx: Tx, input: ReleaseInput): Promise<Inspection> {
  const { account, placeholder, refusals } = await readState(tx, input);
  if (!account) {
    return {
      account: null,
      placeholder,
      openLinks: { activation: 0, passwordReset: 0, emailVerification: 0 },
      liveSessions: 0,
      relations: null,
      refusals,
    };
  }
  // One after another: these share the transaction's single connection.
  const activation = await tx.customerActivationToken.count({ where: { customerId: account.id, usedAt: null } });
  const passwordReset = await tx.passwordResetToken.count({ where: { userId: account.id, usedAt: null } });
  const emailVerification = await tx.emailVerificationToken.count({ where: { userId: account.id, usedAt: null } });
  const liveSessions = await tx.session.count({ where: { userId: account.id, revokedAt: null } });
  const relations = await relationFingerprint(tx, account.id);
  return {
    account: {
      id: account.id,
      email: maskEmail(account.email),
      role: account.role,
      customerOrigin: account.customerOrigin,
      isActive: account.isActive,
      emailVerified: account.emailVerifiedAt !== null,
      hasPassword: account.passwordHash !== null,
    },
    placeholder,
    openLinks: { activation, passwordReset, emailVerification },
    liveSessions,
    relations,
    refusals,
  };
}

export async function planRelease(tx: Tx, input: ReleaseInput): Promise<string[]> {
  return (await readState(tx, input)).refusals;
}

// ── manifests ───────────────────────────────────────────────────────────────

export type ReleaseManifest = {
  version: 1;
  action: 'release';
  appliedAt: string;
  userId: string;
  before: { email: string };
  after: { email: string };
  /** Stays NULL on both sides: a release never proves or un-proves anything. */
  emailVerifiedAt: null;
  revoked: { sessions: number; activationLinks: number; passwordResetLinks: number; emailVerificationLinks: number };
  relations: RelationFingerprint;
};

export type RollbackManifest = {
  version: 1;
  action: 'rollback';
  appliedAt: string;
  userId: string;
  before: { email: string };
  after: { email: string };
  relations: RelationFingerprint;
};

export type Manifest = ReleaseManifest | RollbackManifest;

export function parseManifest(text: string): ReleaseManifest {
  const parsed = JSON.parse(text) as Partial<ReleaseManifest>;
  if (
    parsed?.version !== 1 ||
    parsed.action !== 'release' ||
    typeof parsed.userId !== 'string' ||
    typeof parsed.before?.email !== 'string' ||
    typeof parsed.after?.email !== 'string'
  ) {
    throw new Error('not a release-customer-email release manifest (version 1)');
  }
  return parsed as ReleaseManifest;
}

// ── release ─────────────────────────────────────────────────────────────────

function exactlyOne(count: number, what: string): void {
  if (count !== 1) {
    throw new ReleaseAborted(`${what}: expected to change exactly one row, changed ${count}; the account moved under this run — rolled back`);
  }
}

export async function applyRelease(tx: Tx, input: ReleaseInput, now = new Date()): Promise<ReleaseManifest> {
  const { account, placeholder, refusals } = await readState(tx, input);
  if (refusals.length > 0 || !account?.email) {
    throw new ReleaseRefused(refusals.length > 0 ? refusals : ['the account has no address to release']);
  }
  const before = await relationFingerprint(tx, account.id);

  // Every predicate the plan judged, restated in the write: a claim, a proof
  // or a new address landing between the read and here changes nothing.
  const changed = await tx.user.updateMany({
    where: {
      id: account.id,
      email: account.email,
      role: UserRole.CUSTOMER,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
      passwordHash: null,
      emailVerifiedAt: null,
    },
    data: { email: placeholder },
  });
  exactlyOne(changed.count, 'release');

  // Links mailed to the old address. An activation link carries no copy of
  // the address it was sent to, so an unspent one would otherwise still sign
  // its holder into this account — and prove the placeholder.
  const activationLinks = await tx.customerActivationToken.updateMany({
    where: { customerId: account.id, usedAt: null },
    data: { usedAt: now },
  });
  const passwordResetLinks = await tx.passwordResetToken.updateMany({
    where: { userId: account.id, usedAt: null },
    data: { usedAt: now },
  });
  const emailVerificationLinks = await tx.emailVerificationToken.updateMany({
    where: { userId: account.id, usedAt: null },
    data: { usedAt: now },
  });
  const sessions = await tx.session.updateMany({
    where: { userId: account.id, revokedAt: null },
    data: { revokedAt: now },
  });

  const after = await relationFingerprint(tx, account.id);
  if (!sameRelations(before, after)) {
    throw new ReleaseAborted('a relation of the account changed during the release; rolled back');
  }
  const end = await tx.user.findUnique({ where: { id: account.id }, select: { email: true, emailVerifiedAt: true } });
  if (end?.email !== placeholder || end.emailVerifiedAt !== null) {
    throw new ReleaseAborted('the account did not end on the placeholder with an unproven address; rolled back');
  }

  return {
    version: 1,
    action: 'release',
    appliedAt: now.toISOString(),
    userId: account.id,
    before: { email: account.email },
    after: { email: placeholder },
    emailVerifiedAt: null,
    revoked: {
      sessions: sessions.count,
      activationLinks: activationLinks.count,
      passwordResetLinks: passwordResetLinks.count,
      emailVerificationLinks: emailVerificationLinks.count,
    },
    relations: before,
  };
}

// ── rollback ────────────────────────────────────────────────────────────────

async function rollbackRefusals(tx: Tx, manifest: ReleaseManifest) {
  const refusals: string[] = [];
  const account = await tx.user.findUnique({ where: { id: manifest.userId }, select: accountSelect });
  const holder = await tx.user.findUnique({ where: { email: manifest.before.email }, select: { id: true, role: true } });
  if (!account) refusals.push('the manifest\'s account no longer exists');
  else {
    if (account.email !== manifest.after.email) refusals.push('the account no longer holds the placeholder the release gave it');
    if (account.role !== UserRole.CUSTOMER) refusals.push(`the account is now ${account.role}`);
    if (account.passwordHash !== null) refusals.push('the account has a password since the release');
    if (account.emailVerifiedAt !== null) refusals.push('the account has a proven address since the release');
  }
  if (holder && holder.id !== manifest.userId) {
    refusals.push(`the old address is held by a ${holder.role} account now; giving it back would take it from that account`);
  }
  return { refusals, account };
}

export async function planRollback(tx: Tx, manifest: ReleaseManifest): Promise<string[]> {
  return (await rollbackRefusals(tx, manifest)).refusals;
}

/**
 * Gives the address back. The links and sessions the release spent stay
 * spent — they were issued for a state that is gone — and the address stays
 * unproven, exactly as it was before the release.
 */
export async function applyRollback(tx: Tx, manifest: ReleaseManifest, now = new Date()): Promise<RollbackManifest> {
  const { refusals, account } = await rollbackRefusals(tx, manifest);
  if (refusals.length > 0 || !account) throw new ReleaseRefused(refusals);
  const before = await relationFingerprint(tx, account.id);
  const changed = await tx.user.updateMany({
    where: { id: account.id, email: manifest.after.email, role: UserRole.CUSTOMER, passwordHash: null, emailVerifiedAt: null },
    data: { email: manifest.before.email },
  });
  exactlyOne(changed.count, 'rollback');
  const after = await relationFingerprint(tx, account.id);
  if (!sameRelations(before, after)) {
    throw new ReleaseAborted('a relation of the account changed during the rollback; rolled back');
  }
  return {
    version: 1,
    action: 'rollback',
    appliedAt: now.toISOString(),
    userId: account.id,
    before: { email: manifest.after.email },
    after: { email: manifest.before.email },
    relations: after,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

type Command = 'inspect' | 'release' | 'rollback';
const COMMANDS: readonly Command[] = ['inspect', 'release', 'rollback'];

export type Cli = {
  command: Command;
  apply: boolean;
  userId: string | null;
  email: string | null;
  confirmEmail: string | null;
  manifest: string | null;
  out: string;
};

export function parseArgs(argv: string[]): Cli {
  const args = argv.filter((arg) => arg !== '--');
  const command = args.shift() as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error(`first argument must be one of: ${COMMANDS.join(', ')}`);
  }
  const cli: Cli = {
    command,
    apply: false,
    userId: null,
    email: null,
    confirmEmail: null,
    manifest: null,
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
    else if (arg === '--user-id') cli.userId = value(arg, i++).trim();
    else if (arg === '--email') cli.email = normalizeEmail(value(arg, i++));
    else if (arg === '--confirm-email') cli.confirmEmail = normalizeEmail(value(arg, i++));
    else if (arg === '--manifest') cli.manifest = value(arg, i++);
    else if (arg === '--out') cli.out = value(arg, i++);
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (command !== 'rollback') {
    if (!cli.userId) throw new Error(`${command} needs --user-id`);
    if (!cli.email) throw new Error(`${command} needs --email with a valid address`);
  }
  // The address is what is being given away; a typo would release the wrong
  // account or none, so it is asked for twice.
  if (command === 'release' && cli.confirmEmail !== cli.email) {
    throw new Error('release needs --confirm-email repeating --email exactly');
  }
  if (command === 'rollback' && !cli.manifest) throw new Error('rollback needs --manifest');
  if (command === 'inspect' && cli.apply) throw new Error('inspect only reads; it takes no --apply');
  return cli;
}

function writePrivate(dir: string, name: string, body: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return file;
}

/** The manifest as the console shows it: every address masked. */
export function safeManifest(manifest: Manifest): Record<string, unknown> {
  return {
    ...manifest,
    before: { email: maskEmail(manifest.before.email) },
    after: { email: maskEmail(manifest.after.email) },
  };
}

function printInspection(result: Inspection): void {
  if (!result.account) {
    console.log('account                  : none');
  } else {
    const a = result.account;
    console.log(
      `account                  : ${a.id} ${a.email} role=${a.role} origin=${a.customerOrigin ?? 'none'} ` +
        `active=${a.isActive} emailVerified=${a.emailVerified} password=${a.hasPassword ? 'set' : 'none'}`,
    );
    console.log(`placeholder              : ${result.placeholder}`);
    console.log(
      `open links               : activation=${result.openLinks.activation} passwordReset=${result.openLinks.passwordReset} ` +
        `emailVerification=${result.openLinks.emailVerification}`,
    );
    console.log(`live sessions            : ${result.liveSessions}`);
    const refs = Object.entries(result.relations?.references ?? {}).filter(([, n]) => n > 0);
    console.log(`relations (unchanged)    : ${refs.map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`);
  }
  if (result.refusals.length === 0) console.log('release                  : allowed');
  else {
    console.log('release                  : refused');
    for (const refusal of result.refusals) console.log(`  - ${refusal}`);
  }
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

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prisma = new PrismaClient();
  const banner = (what: string) => console.log(`\n=== RELEASE CUSTOMER EMAIL — ${cli.command.toUpperCase()} — ${what} ===\n`);
  const refused = (refusals: string[]) => {
    console.log('refusals:');
    for (const refusal of refusals) console.log(`  - ${refusal}`);
    process.exitCode = 2;
  };
  const input = { userId: cli.userId ?? '', email: cli.email ?? '' };

  try {
    if (cli.command === 'inspect') {
      banner('READ ONLY');
      const result = await readOnly(prisma, (tx) => inspect(tx, input));
      printInspection(result);
      if (result.refusals.length > 0) process.exitCode = 2;
      return;
    }

    const manifest = cli.manifest ? parseManifest(readFileSync(cli.manifest, 'utf8')) : null;
    const plan = (tx: Tx) => (cli.command === 'release' ? planRelease(tx, input) : planRollback(tx, manifest!));

    if (!cli.apply) {
      banner('DRY RUN (nothing changed)');
      const refusals = await readOnly(prisma, plan);
      if (refusals.length > 0) refused(refusals);
      else console.log('no refusals: --apply would run this step');
      return;
    }

    const result = await serializable(prisma, (tx): Promise<Manifest> =>
      cli.command === 'release' ? applyRelease(tx, input) : applyRollback(tx, manifest!),
    );
    banner('APPLIED');
    console.log(JSON.stringify(safeManifest(result), null, 2));
    const file = writePrivate(cli.out, `release-customer-email-${stamp}-${result.action}.json`, result);
    console.log(`\nmanifest written to ${file} (mode 0600; rollback reads the release manifest)`);
  } catch (error) {
    if (error instanceof ReleaseRefused) {
      banner('REFUSED (nothing changed)');
      refused(error.refusals);
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      banner('CONFLICT (nothing changed)');
      console.log('another transaction changed the account at the same time; run the dry run again');
      process.exitCode = 3;
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
