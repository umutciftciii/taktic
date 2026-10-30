import { realpathSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { attemptKeyHash } from '../modules/auth/login-attempts.service';

/**
 * Lifts the sign-in lock on one e-mail (SEC-AUTH-ABUSE-001), for the operator
 * on the host — the break-glass path when an operator is locked out of the
 * admin panel and cannot wait out the lock or complete a password reset.
 *
 *   pnpm --filter @taktic/api auth-lock:clear -- inspect --email EMAIL
 *       read-only: whether the e-mail's account scope or any of its address
 *       pairs is counting or locked, and until when
 *   clear --email EMAIL --confirm-email EMAIL [--apply]
 *       deletes those rows — exactly what a completed password reset does
 *
 * Only the e-mail's own scopes are touched; an address lock (one address
 * against many accounts) is never lifted here, because it is not this
 * account's. Nothing is changed about the account, its password or its
 * sessions. The console shows the address masked; the counters hold only
 * digests, so there is nothing else to show.
 *
 * Dry run unless --apply is given.
 */

export function normalizeEmail(value: string | undefined | null): string | null {
  const folded = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(folded) ? folded : null;
}

function mask(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

type Cli = { command: 'inspect' | 'clear'; email: string; confirmEmail: string | null; apply: boolean };

export function parseArgs(argv: string[]): Cli {
  const [command, ...rest] = argv.filter((arg) => arg !== '--');
  if (command !== 'inspect' && command !== 'clear') {
    throw new Error('usage: auth-lock:clear -- inspect --email EMAIL | clear --email EMAIL --confirm-email EMAIL [--apply]');
  }
  let email: string | null = null;
  let confirmEmail: string | null = null;
  let apply = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--email') email = normalizeEmail(rest[(i += 1)]);
    else if (arg === '--confirm-email') confirmEmail = normalizeEmail(rest[(i += 1)]);
    else if (arg === '--apply') apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!email) throw new Error('--email must be an e-mail address');
  if (command === 'inspect' && apply) throw new Error('inspect only reads; it takes no --apply');
  if (command === 'clear' && confirmEmail !== email) {
    throw new Error('--confirm-email must repeat --email exactly: the e-mail is named twice so a typo clears nothing');
  }
  return { command, email, confirmEmail, apply };
}

export async function inspectAuthLock(prisma: PrismaClient, email: string, now: Date = new Date()) {
  const account = attemptKeyHash('ACCOUNT', email);
  const rows = await prisma.authAttemptCounter.findMany({
    where: { OR: [{ scope: 'ACCOUNT', keyHash: account }, { scope: 'IP_ACCOUNT', accountKeyHash: account }] },
    orderBy: [{ scope: 'asc' }, { updatedAt: 'desc' }],
  });
  return rows.map((row) => ({
    scope: row.scope,
    attempts: row.attempts,
    locked: row.lockedUntil !== null && row.lockedUntil > now,
    lockedUntil: row.lockedUntil,
  }));
}

export async function clearAuthLock(prisma: PrismaClient, email: string): Promise<number> {
  const account = attemptKeyHash('ACCOUNT', email);
  const { count } = await prisma.authAttemptCounter.deleteMany({
    where: { OR: [{ scope: 'ACCOUNT', keyHash: account }, { scope: 'IP_ACCOUNT', accountKeyHash: account }] },
  });
  return count;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const rows = await inspectAuthLock(prisma, cli.email);
    console.log(`auth-lock: ${mask(cli.email)} — ${rows.length} counter row(s)`);
    for (const row of rows) {
      console.log(
        `  ${row.scope.padEnd(10)} attempts=${row.attempts} ${row.locked ? `LOCKED until ${row.lockedUntil?.toISOString()}` : 'not locked'}`,
      );
    }
    if (cli.command === 'inspect') return;
    if (!cli.apply) {
      console.log(`dry run: --apply would delete ${rows.length} row(s)`);
      return;
    }
    const deleted = await clearAuthLock(prisma, cli.email);
    console.log(`auth-lock: deleted ${deleted} row(s); ${mask(cli.email)} may sign in again`);
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
