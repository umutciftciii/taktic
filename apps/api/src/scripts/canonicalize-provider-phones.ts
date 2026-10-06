import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { isCanonicalPhone, normalizePhoneNumber } from '../modules/phone-verification/phone.util';

/**
 * Rewrites every `ProviderProfile.phone` into canonical E.164
 * (CONTACT-PHONE-DATA-HYGIENE-001) — the form every write path stores from
 * this change on.
 *
 *   pnpm --filter @taktic/api canonicalize:provider-phones
 *       dry run (the default): reads, plans, writes the plan, changes nothing
 *   pnpm --filter @taktic/api canonicalize:provider-phones -- --apply [--out DIR]
 *
 * The business's contact number is current profile data — the provider edits
 * it, and it is what a customer is shown once contact opens — so rewriting its
 * spelling changes nothing it means. It is not an identity: no uniqueness is
 * involved and two profiles may share a number, so unlike
 * canonicalize-user-phones there is no collision to resolve.
 *
 * The canonical form is whatever `normalizePhoneNumber` returns. A row is
 * planned only when that function accepts its value and returns something
 * different. A value it refuses is reported and --apply is refused: it needs a
 * person, not a guess.
 *
 * For a profile with an owner, the plan also says whether the canonical
 * number is the owner's `User.phone`. That is information, never an input:
 * the two are different facts (the business line and the person's own
 * number) and this script does not touch `User`. What it guarantees is that a
 * profile whose number already *meant* the owner's keeps meaning it — after
 * --apply the two are equal as text, too.
 *
 * --apply runs as one SERIALIZABLE transaction. Every write is guarded by the
 * exact value the plan read (`WHERE id = $1 AND phone = $2`) and must touch
 * exactly one row; before commit the table is re-read and must hold no
 * non-canonical number, and no owned profile may have lost a match with its
 * owner. Any miss rolls the whole run back.
 *
 * The plan, and after --apply the applied manifest (id, oldPhone, newPhone),
 * are written outside the repository — they carry telephone numbers — into
 * --out, $TAKTIC_OPS_OUTPUT_DIR, or ~/Backups/taktic/ops, with mode 0600.
 */

export type OwnerMatch = 'no-owner' | 'owner-has-no-phone' | 'matches' | 'differs';

export type PlannedChange = {
  providerId: string;
  oldPhone: string;
  newPhone: string;
  owner: OwnerMatch;
};

export type Plan = {
  scanned: number;
  alreadyCanonical: number;
  changes: PlannedChange[];
  unsupported: Array<{ providerId: string; phone: string }>;
  /** Owned profiles by how their number relates to the owner's, before and after. */
  ownerMatch: { before: Record<OwnerMatch, number>; after: Record<OwnerMatch, number> };
  /** Why --apply would be refused; empty when it would not be. */
  refusals: string[];
};

export type ApplyResult = {
  plan: Plan;
  applied: PlannedChange[];
  after: { nonCanonical: number; ownerMatch: Record<OwnerMatch, number> };
};

type ProviderPhoneRow = { id: string; phone: string; ownerPhone: string | null; hasOwner: boolean };

/**
 * Raw SQL over the unqualified tables, on whatever transaction client the
 * caller passes in: the CLI's, against the configured database, or a test's,
 * whose `SET LOCAL search_path` points it at a scratch schema.
 */
type Db = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export class CanonicalizationRefused extends Error {
  constructor(readonly plan: Plan) {
    super(`canonicalize-provider-phones: apply refused — ${plan.refusals.join('; ')}`);
  }
}

export class CanonicalizationAborted extends Error {}

async function readPhones(db: Db): Promise<ProviderPhoneRow[]> {
  return db.$queryRawUnsafe<ProviderPhoneRow[]>(
    `SELECT p."id", p."phone", u."phone" AS "ownerPhone", (p."userId" IS NOT NULL) AS "hasOwner"
       FROM "ProviderProfile" p
       LEFT JOIN "User" u ON u."id" = p."userId"
      ORDER BY p."id"`,
  );
}

function canonicalOrNull(value: string): string | null {
  try {
    return normalizePhoneNumber(value);
  } catch {
    return null;
  }
}

/**
 * Whether the profile's number is the owner's. Compared by meaning — both
 * sides through the canonicaliser — so a format-only difference is a match
 * both before and after a rewrite.
 */
function ownerMatch(phone: string, row: ProviderPhoneRow, byText = false): OwnerMatch {
  if (!row.hasOwner) return 'no-owner';
  if (row.ownerPhone === null) return 'owner-has-no-phone';
  if (byText) return phone === row.ownerPhone ? 'matches' : 'differs';
  const a = canonicalOrNull(phone);
  return a !== null && a === canonicalOrNull(row.ownerPhone) ? 'matches' : 'differs';
}

function emptyTally(): Record<OwnerMatch, number> {
  return { 'no-owner': 0, 'owner-has-no-phone': 0, matches: 0, differs: 0 };
}

/** Reads the table and decides — without writing — what --apply would do. */
export async function planCanonicalization(db: Db): Promise<Plan> {
  const rows = await readPhones(db);
  const unsupported: Plan['unsupported'] = [];
  const changes: PlannedChange[] = [];
  const before = emptyTally();
  const after = emptyTally();
  let alreadyCanonical = 0;

  for (const row of rows) {
    // Before: as the rows read today, by meaning. After: what --apply leaves,
    // by text — the stronger claim the rewrite is supposed to make true.
    before[ownerMatch(row.phone, row)] += 1;
    const canonical = canonicalOrNull(row.phone);
    if (canonical === null) {
      unsupported.push({ providerId: row.id, phone: row.phone });
      after[ownerMatch(row.phone, row, true)] += 1;
      continue;
    }
    after[ownerMatch(canonical, row, true)] += 1;
    if (canonical === row.phone) {
      alreadyCanonical += 1;
      continue;
    }
    changes.push({ providerId: row.id, oldPhone: row.phone, newPhone: canonical, owner: ownerMatch(row.phone, row) });
  }

  const refusals: string[] = [];
  if (unsupported.length > 0) {
    refusals.push(`${unsupported.length} phone value(s) the canonicaliser refuses`);
  }

  return {
    scanned: rows.length,
    alreadyCanonical,
    changes,
    unsupported,
    ownerMatch: { before, after },
    refusals,
  };
}

/** What --apply has to leave behind for the run to count as a success. */
export async function verifyCanonical(db: Db): Promise<ApplyResult['after']> {
  const rows = await readPhones(db);
  const tally = emptyTally();
  for (const row of rows) tally[ownerMatch(row.phone, row, true)] += 1;
  return { nonCanonical: rows.filter((row) => !isCanonicalPhone(row.phone)).length, ownerMatch: tally };
}

/**
 * Plans and applies inside the caller's transaction. Throws — and so rolls the
 * caller's transaction back — on a refusal, a guard miss, a table that does not
 * end up fully canonical, or an owned profile that stopped matching its owner.
 */
export async function applyCanonicalization(db: Db): Promise<ApplyResult> {
  const plan = await planCanonicalization(db);
  if (plan.refusals.length > 0) {
    throw new CanonicalizationRefused(plan);
  }

  for (const change of plan.changes) {
    const touched = await db.$executeRawUnsafe(
      'UPDATE "ProviderProfile" SET "phone" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2 AND "phone" = $3',
      change.newPhone,
      change.providerId,
      change.oldPhone,
    );
    if (touched !== 1) {
      throw new CanonicalizationAborted(
        `canonicalize-provider-phones: ${change.providerId} no longer holds the value the plan read (${touched} row(s) matched); rolled back`,
      );
    }
  }

  const after = await verifyCanonical(db);
  if (after.nonCanonical !== 0) {
    throw new CanonicalizationAborted(
      `canonicalize-provider-phones: after apply ${after.nonCanonical} non-canonical value(s) remain; rolled back`,
    );
  }
  // Every owned profile whose number meant the owner's before must equal it
  // as text now; a smaller count means a rewrite moved a number away.
  if (after.ownerMatch.matches < plan.ownerMatch.before.matches) {
    throw new CanonicalizationAborted(
      `canonicalize-provider-phones: owner matches dropped from ${plan.ownerMatch.before.matches} to ${after.ownerMatch.matches}; rolled back`,
    );
  }

  return { plan, applied: plan.changes, after };
}

type Cli = { apply: boolean; out: string };

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    apply: false,
    out: process.env.TAKTIC_OPS_OUTPUT_DIR || join(homedir(), 'Backups', 'taktic', 'ops'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--apply') cli.apply = true;
    else if (arg === '--dry-run') cli.apply = false;
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

function printTally(label: string, tally: Record<OwnerMatch, number>): void {
  console.log(
    `${label}: matches=${tally.matches} differs=${tally.differs} owner-has-no-phone=${tally['owner-has-no-phone']} no-owner=${tally['no-owner']}`,
  );
}

function printPlan(plan: Plan): void {
  console.log(`profiles scanned        : ${plan.scanned}`);
  console.log(`already canonical       : ${plan.alreadyCanonical}`);
  console.log(`planned changes         : ${plan.changes.length}`);
  for (const change of plan.changes) {
    console.log(`  ${change.providerId} ${change.oldPhone} → ${change.newPhone} (owner: ${change.owner})`);
  }
  console.log(`unsupported values      : ${plan.unsupported.length}`);
  for (const row of plan.unsupported) {
    console.log(`  ${row.providerId} ${row.phone}`);
  }
  printTally('owner match before (by meaning)', plan.ownerMatch.before);
  printTally('owner match after  (by text)   ', plan.ownerMatch.after);
  console.log(`apply refusals          : ${plan.refusals.length === 0 ? 'none' : ''}`);
  for (const refusal of plan.refusals) console.log(`  - ${refusal}`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prisma = new PrismaClient();

  try {
    if (!cli.apply) {
      const plan = await prisma.$transaction(async (tx) => {
        // A dry run cannot write, whatever a future edit to this file does.
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return planCanonicalization(tx);
      });
      console.log('\n=== CANONICALIZE PROVIDER PHONES — DRY RUN (no rows changed) ===\n');
      printPlan(plan);
      const file = writePrivate(cli.out, `canonicalize-provider-phones-${stamp}-plan.json`, { mode: 'dry-run', ...plan });
      console.log(`\nplan written to ${file}`);
      process.exitCode = plan.refusals.length > 0 ? 2 : 0;
      return;
    }

    const result = await prisma.$transaction((tx) => applyCanonicalization(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 60_000,
    });
    console.log('\n=== CANONICALIZE PROVIDER PHONES — APPLIED ===\n');
    printPlan(result.plan);
    console.log(`\nafter: non-canonical=${result.after.nonCanonical}`);
    printTally('after owner match', result.after.ownerMatch);
    const file = writePrivate(cli.out, `canonicalize-provider-phones-${stamp}-applied.json`, {
      mode: 'apply',
      after: result.after,
      changes: result.applied.map(({ providerId, oldPhone, newPhone }) => ({ providerId, oldPhone, newPhone })),
    });
    console.log(`manifest written to ${file}`);
  } catch (error) {
    if (error instanceof CanonicalizationRefused) {
      console.error('\n=== CANONICALIZE PROVIDER PHONES — APPLY REFUSED (no rows changed) ===\n');
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
