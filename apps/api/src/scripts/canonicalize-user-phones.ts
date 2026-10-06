import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { isCanonicalPhone, normalizePhoneNumber } from '../modules/phone-verification/phone.util';

/**
 * Rewrites every `User.phone` into the one form the database will accept from
 * the `user_phone_e164_check` migration on (AUTH-REG-002).
 *
 *   pnpm --filter @taktic/api canonicalize:user-phones
 *       dry run (the default): reads, plans, writes the plan, changes nothing
 *   pnpm --filter @taktic/api canonicalize:user-phones -- --apply [--resolutions FILE] [--out DIR]
 *
 * The canonical form is whatever `normalizePhoneNumber` returns — the
 * application's own canonicaliser, not a second algorithm. A row is planned
 * only when that function accepts its value and returns something different.
 *
 * What it will not do by itself:
 *
 *  - decide who keeps a number. When two accounts' values canonicalise to the
 *    same number, that is a collision; it is reported, and --apply is refused
 *    until a resolution file names, for every collision, the accounts that give
 *    the number up (by id and by the exact value they hold now). A resolution
 *    clears the number (`phone = NULL`); nothing is deleted or merged.
 *  - guess at a value the canonicaliser refuses. Such a row is reported and
 *    --apply is refused; it needs a person.
 *
 * --apply runs as one SERIALIZABLE transaction. Every write is guarded by the
 * exact value the plan read (`WHERE id = $1 AND phone = $2`) and must touch
 * exactly one row; before commit the table is re-read and must hold no
 * non-canonical number and no number twice. Any miss rolls the whole run back.
 *
 * The plan, and after --apply the applied manifest (id, oldPhone, newPhone),
 * are written outside the repository — they carry telephone numbers — into
 * --out, $TAKTIC_OPS_OUTPUT_DIR, or ~/Backups/taktic/ops, with mode 0600.
 */

export type ResolutionEntry = {
  userId: string;
  /** The exact value the account holds now; a mismatch refuses the run. */
  expectedPhone: string;
  action: 'clear';
};

export type ResolutionFile = {
  version: 1;
  resolutions: ResolutionEntry[];
};

export type PlannedChange = {
  userId: string;
  role: string;
  oldPhone: string;
  newPhone: string | null;
  reason: 'canonicalize' | 'resolution-clear';
};

export type CollisionMember = {
  userId: string;
  role: string;
  phone: string;
  resolution: 'keeps' | 'clear';
};

export type Collision = {
  canonicalPhone: string;
  members: CollisionMember[];
  resolved: boolean;
};

export type Plan = {
  scanned: number;
  withPhone: number;
  alreadyCanonical: number;
  changes: PlannedChange[];
  collisions: Collision[];
  unsupported: Array<{ userId: string; role: string; phone: string }>;
  /** Why --apply would be refused; empty when it would not be. */
  refusals: string[];
};

export type ApplyResult = {
  plan: Plan;
  applied: PlannedChange[];
  after: { nonCanonical: number; duplicateGroups: number };
};

type UserPhoneRow = { id: string; role: string; phone: string };

/**
 * Raw SQL over the unqualified "User" table, on whatever transaction client
 * the caller passes in: the CLI's, against the configured database, or a
 * test's, whose `SET LOCAL search_path` points it at a scratch schema.
 */
type Db = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export class CanonicalizationRefused extends Error {
  constructor(readonly plan: Plan) {
    super(`canonicalize-user-phones: apply refused — ${plan.refusals.join('; ')}`);
  }
}

export class CanonicalizationAborted extends Error {}

async function readPhones(db: Db): Promise<{ scanned: number; rows: UserPhoneRow[] }> {
  const [total] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT count(*) AS count FROM "User"',
  );
  const rows = await db.$queryRawUnsafe<UserPhoneRow[]>(
    'SELECT "id", "role"::text AS "role", "phone" FROM "User" WHERE "phone" IS NOT NULL ORDER BY "id"',
  );
  return { scanned: Number(total?.count ?? 0), rows };
}

function canonicalOrNull(value: string): string | null {
  try {
    return normalizePhoneNumber(value);
  } catch {
    return null;
  }
}

/** Reads the table and decides — without writing — what --apply would do. */
export async function planCanonicalization(
  db: Db,
  resolutionFile: ResolutionFile | null,
): Promise<Plan> {
  const { scanned, rows } = await readPhones(db);
  const resolutions = resolutionFile?.resolutions ?? [];
  const refusals: string[] = [];
  const unsupported: Plan['unsupported'] = [];
  const groups = new Map<string, UserPhoneRow[]>();

  for (const row of rows) {
    const canonical = canonicalOrNull(row.phone);
    if (canonical === null) {
      unsupported.push({ userId: row.id, role: row.role, phone: row.phone });
      continue;
    }
    const members = groups.get(canonical) ?? [];
    members.push(row);
    groups.set(canonical, members);
  }

  if (unsupported.length > 0) {
    refusals.push(`${unsupported.length} phone value(s) the canonicaliser refuses`);
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const clearIds = new Set<string>();
  const seenResolutionIds = new Set<string>();

  for (const entry of resolutions) {
    if (entry.action !== 'clear') {
      refusals.push(`resolution for ${entry.userId}: unknown action ${String(entry.action)}`);
      continue;
    }
    if (seenResolutionIds.has(entry.userId)) {
      refusals.push(`resolution for ${entry.userId}: listed twice`);
      continue;
    }
    seenResolutionIds.add(entry.userId);
    const row = byId.get(entry.userId);
    if (!row) {
      refusals.push(`resolution for ${entry.userId}: no such account with a phone`);
      continue;
    }
    if (row.phone !== entry.expectedPhone) {
      refusals.push(`resolution for ${entry.userId}: stored value differs from expectedPhone`);
      continue;
    }
    clearIds.add(entry.userId);
  }

  const collisions: Collision[] = [];
  const collidingIds = new Set<string>();
  for (const [canonicalPhone, members] of groups) {
    if (members.length < 2) continue;
    for (const member of members) collidingIds.add(member.id);
    const keepers = members.filter((member) => !clearIds.has(member.id));
    const resolved = keepers.length <= 1;
    if (!resolved) {
      refusals.push(`unresolved collision on one canonical number (${members.length} accounts)`);
    }
    collisions.push({
      canonicalPhone,
      resolved,
      members: members.map((member) => ({
        userId: member.id,
        role: member.role,
        phone: member.phone,
        resolution: clearIds.has(member.id) ? 'clear' : 'keeps',
      })),
    });
  }

  // A resolution may only ever settle a collision. Clearing the number of an
  // account nobody else claims is not this script's decision to make.
  for (const id of clearIds) {
    if (!collidingIds.has(id)) {
      refusals.push(`resolution for ${id}: account is not part of any collision`);
    }
  }

  const changes: PlannedChange[] = [];
  let alreadyCanonical = 0;
  for (const row of rows) {
    if (clearIds.has(row.id) && collidingIds.has(row.id)) {
      changes.push({ userId: row.id, role: row.role, oldPhone: row.phone, newPhone: null, reason: 'resolution-clear' });
      continue;
    }
    const canonical = canonicalOrNull(row.phone);
    if (canonical === null) continue;
    if (canonical === row.phone) {
      alreadyCanonical += 1;
      continue;
    }
    changes.push({ userId: row.id, role: row.role, oldPhone: row.phone, newPhone: canonical, reason: 'canonicalize' });
  }

  return {
    scanned,
    withPhone: rows.length,
    alreadyCanonical,
    changes,
    collisions,
    unsupported,
    refusals,
  };
}

/** What --apply has to leave behind for the run to count as a success. */
export async function verifyCanonical(db: Db): Promise<ApplyResult['after']> {
  const { rows } = await readPhones(db);
  const nonCanonical = rows.filter((row) => !isCanonicalPhone(row.phone)).length;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = canonicalOrNull(row.phone) ?? row.phone;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateGroups = [...counts.values()].filter((n) => n > 1).length;
  return { nonCanonical, duplicateGroups };
}

/**
 * Plans and applies inside the caller's transaction. Throws — and so rolls the
 * caller's transaction back — on a refusal, a guard miss, or a table that does
 * not end up fully canonical.
 */
export async function applyCanonicalization(
  db: Db,
  resolutionFile: ResolutionFile | null,
): Promise<ApplyResult> {
  const plan = await planCanonicalization(db, resolutionFile);
  if (plan.refusals.length > 0) {
    throw new CanonicalizationRefused(plan);
  }

  // Clears first: a number given up must be free before another account's
  // spelling of it is rewritten into it, or the unique index would object.
  const ordered = [
    ...plan.changes.filter((change) => change.newPhone === null),
    ...plan.changes.filter((change) => change.newPhone !== null),
  ];

  for (const change of ordered) {
    const touched = await db.$executeRawUnsafe(
      'UPDATE "User" SET "phone" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2 AND "phone" = $3',
      change.newPhone,
      change.userId,
      change.oldPhone,
    );
    if (touched !== 1) {
      throw new CanonicalizationAborted(
        `canonicalize-user-phones: ${change.userId} no longer holds the value the plan read (${touched} row(s) matched); rolled back`,
      );
    }
  }

  const after = await verifyCanonical(db);
  if (after.nonCanonical !== 0 || after.duplicateGroups !== 0) {
    throw new CanonicalizationAborted(
      `canonicalize-user-phones: after apply ${after.nonCanonical} non-canonical value(s) and ${after.duplicateGroups} duplicate group(s) remain; rolled back`,
    );
  }

  return { plan, applied: ordered, after };
}

export function parseResolutionFile(text: string): ResolutionFile {
  const parsed = JSON.parse(text) as Partial<ResolutionFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.resolutions)) {
    throw new Error('resolution file must be { "version": 1, "resolutions": [...] }');
  }
  for (const entry of parsed.resolutions) {
    if (
      typeof entry?.userId !== 'string' ||
      typeof entry?.expectedPhone !== 'string' ||
      entry?.action !== 'clear'
    ) {
      throw new Error('each resolution must be { "userId": string, "expectedPhone": string, "action": "clear" }');
    }
  }
  return parsed as ResolutionFile;
}

type Cli = { apply: boolean; resolutions: string | null; out: string };

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    apply: false,
    resolutions: null,
    out: process.env.TAKTIC_OPS_OUTPUT_DIR || join(homedir(), 'Backups', 'taktic', 'ops'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--apply') cli.apply = true;
    else if (arg === '--dry-run') cli.apply = false;
    else if (arg === '--resolutions') cli.resolutions = argv[++i] ?? null;
    else if (arg === '--out') cli.out = argv[++i] ?? cli.out;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return cli;
}

function writePrivate(dir: string, name: string, body: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function printPlan(plan: Plan): void {
  console.log(`users scanned           : ${plan.scanned}`);
  console.log(`users with a phone      : ${plan.withPhone}`);
  console.log(`already canonical       : ${plan.alreadyCanonical}`);
  console.log(`planned changes         : ${plan.changes.length}`);
  for (const change of plan.changes) {
    console.log(`  ${change.userId} ${change.role.padEnd(11)} ${change.oldPhone} → ${change.newPhone ?? 'NULL'} (${change.reason})`);
  }
  console.log(`collisions              : ${plan.collisions.length}`);
  for (const collision of plan.collisions) {
    console.log(`  ${collision.canonicalPhone} ${collision.resolved ? 'resolved' : 'UNRESOLVED'}`);
    for (const member of collision.members) {
      console.log(`    ${member.userId} ${member.role.padEnd(11)} ${member.phone} → ${member.resolution}`);
    }
  }
  console.log(`unsupported values      : ${plan.unsupported.length}`);
  for (const row of plan.unsupported) {
    console.log(`  ${row.userId} ${row.role.padEnd(11)} ${row.phone}`);
  }
  console.log(`apply refusals          : ${plan.refusals.length === 0 ? 'none' : ''}`);
  for (const refusal of plan.refusals) console.log(`  - ${refusal}`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const resolutionFile = cli.resolutions ? parseResolutionFile(readFileSync(cli.resolutions, 'utf8')) : null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prisma = new PrismaClient();

  try {
    if (!cli.apply) {
      const plan = await prisma.$transaction(async (tx) => {
        // A dry run cannot write, whatever a future edit to this file does.
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return planCanonicalization(tx, resolutionFile);
      });
      console.log('\n=== CANONICALIZE USER PHONES — DRY RUN (no rows changed) ===\n');
      printPlan(plan);
      const file = writePrivate(cli.out, `canonicalize-user-phones-${stamp}-plan.json`, { mode: 'dry-run', ...plan });
      console.log(`\nplan written to ${file}`);
      process.exitCode = plan.refusals.length > 0 ? 2 : 0;
      return;
    }

    const result = await prisma.$transaction((tx) => applyCanonicalization(tx, resolutionFile), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 60_000,
    });
    console.log('\n=== CANONICALIZE USER PHONES — APPLIED ===\n');
    printPlan(result.plan);
    console.log(`\nafter: non-canonical=${result.after.nonCanonical} duplicate-groups=${result.after.duplicateGroups}`);
    const file = writePrivate(cli.out, `canonicalize-user-phones-${stamp}-applied.json`, {
      mode: 'apply',
      after: result.after,
      changes: result.applied.map(({ userId, oldPhone, newPhone, reason }) => ({ userId, oldPhone, newPhone, reason })),
    });
    console.log(`manifest written to ${file}`);
  } catch (error) {
    if (error instanceof CanonicalizationRefused) {
      console.error('\n=== CANONICALIZE USER PHONES — APPLY REFUSED (no rows changed) ===\n');
      printPlan(error.plan);
      process.exitCode = 2;
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
