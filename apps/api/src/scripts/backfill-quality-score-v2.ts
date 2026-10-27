import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  QUALITY_SCORE_VERSION,
  requestQualityLabel,
  scoreStoredRequest,
  storedRequestQualityInclude,
  type QualityLabel,
  type StoredRequestForQuality,
} from '../modules/service-requests/request-quality';

/**
 * QUALITY-SCORE-001 — moves every request scored by the original quality model
 * to the current one, with a plan to read first and a way back.
 *
 *   pnpm --filter @taktic/api quality:backfill -- plan [--out DIR]
 *       read-only: scores every original-model row with the current model and
 *       writes the plan (every row before and after, the label transitions,
 *       the rows worth a second look) with its digest
 *   apply --plan FILE --confirm-digest SHA256 [--apply] [--out DIR]
 *       moves exactly the rows the plan names, to exactly the results it shows
 *   rollback --manifest FILE [--apply] [--out DIR]
 *       puts every row of an applied manifest back as it was, only while
 *       nothing has touched it since
 *
 * The score is computed by `scoreStoredRequest` — the function the admin
 * recalculation runs — over the category's active form and the request's
 * stored answers. Nothing about a request's content changes after it is
 * created, so those are the inputs it was created with; the one thing that can
 * have moved is the form itself, and the plan flags every row whose category
 * form changed after the request was submitted (`questionSetChanged`).
 *
 * What changes: `qualityScore`, `qualityScoreBreakdown` and
 * `qualityScoreVersion` (1 → 2) of the planned rows. Nothing else — not the
 * status, not `updatedAt`'s meaning for anything but this row, not a credit,
 * an offer, a round, a campaign or a schedule; none of those read the score.
 *
 * Safety:
 *   - Every command is a dry run without --apply (a READ ONLY transaction).
 *   - apply needs the plan's digest repeated (--confirm-digest), refuses when
 *     the set of original-model rows is not exactly the plan's, and runs in one
 *     SERIALIZABLE transaction in which every row is re-read, re-scored and
 *     compared with the plan before a write guarded by its old values. Any
 *     difference refuses the whole run; nothing is half-applied.
 *   - It is idempotent: once applied there is no original-model row left, so a
 *     second plan is empty and an old plan is refused.
 *   - rollback reads the applied manifest, which carries every row's old
 *     score, version and breakdown; a row changed since the apply refuses it.
 *   - Manifests hold request ids, numbers and scores — no name, phone, email,
 *     address or description — and are written outside the repository into
 *     --out, $TAKTIC_OPS_OUTPUT_DIR or ~/Backups/taktic/ops with mode 0600.
 *
 * Exit codes: 0 done, 1 error, 2 refused, 3 serialization conflict (re-plan).
 */

type Tx = Prisma.TransactionClient;

export class BackfillRefused extends Error {
  constructor(readonly refusals: string[]) {
    super(`backfill-quality-score-v2: refused — ${refusals.join('; ')}`);
  }
}

export type PlannedRow = {
  id: string;
  requestNumber: string | null;
  status: string;
  submittedAt: string;
  before: { score: number; version: number; label: QualityLabel; breakdown: Prisma.JsonValue | null };
  after: { score: number; version: number; label: QualityLabel; breakdown: Prisma.JsonValue };
  flags: {
    /** The category's form changed after this request was submitted. */
    questionSetChanged: boolean;
    /** The original model wrote no breakdown for this row. */
    noPriorBreakdown: boolean;
  };
};

export type BackfillPlan = {
  kind: 'quality-score-v2-plan';
  formatVersion: 1;
  createdAt: string;
  targetVersion: number;
  digest: string;
  summary: PlanSummary;
  rows: PlannedRow[];
};

export type AppliedManifest = {
  kind: 'quality-score-v2-applied' | 'quality-score-v2-rolled-back';
  formatVersion: 1;
  createdAt: string;
  planDigest: string;
  rows: PlannedRow[];
};

export type PlanSummary = {
  rows: number;
  labelsBefore: Record<QualityLabel, number>;
  labelsAfter: Record<QualityLabel, number>;
  transitions: Record<string, number>;
  byStatus: Record<string, number>;
  questionSetChanged: number;
  noPriorBreakdown: number;
};

// ── plan ────────────────────────────────────────────────────────────────────

/** Stable JSON: keys sorted at every level, so a digest does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function rowsDigest(rows: PlannedRow[]): string {
  return createHash('sha256').update(canonicalJson(rows)).digest('hex');
}

async function readOriginalModelRows(tx: Tx): Promise<StoredRequestForQuality[]> {
  return tx.serviceRequest.findMany({
    where: { qualityScoreVersion: { lt: QUALITY_SCORE_VERSION } },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    include: storedRequestQualityInclude,
  });
}

/**
 * When each category's form last changed — any question, active or not, so a
 * question switched off after a request was sent counts as a change too.
 */
async function lastFormChanges(tx: Tx): Promise<Map<string, Date>> {
  const groups = await tx.serviceRequestQuestion.groupBy({ by: ['categoryId'], _max: { updatedAt: true } });
  return new Map(
    groups.flatMap((group) => (group._max.updatedAt ? [[group.categoryId, group._max.updatedAt] as const] : [])),
  );
}

function planRow(row: StoredRequestForQuality, lastFormChange: Date | undefined): PlannedRow {
  const result = scoreStoredRequest(row);
  return {
    id: row.id,
    requestNumber: row.requestNumber,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    before: {
      score: row.qualityScore,
      version: row.qualityScoreVersion,
      label: requestQualityLabel(row),
      breakdown: row.qualityScoreBreakdown,
    },
    after: {
      score: result.score,
      version: result.version,
      label: result.label,
      breakdown: JSON.parse(JSON.stringify(result.breakdown)) as Prisma.JsonValue,
    },
    flags: {
      questionSetChanged: lastFormChange !== undefined && lastFormChange.getTime() > row.submittedAt.getTime(),
      noPriorBreakdown: row.qualityScoreBreakdown === null,
    },
  };
}

function summarize(rows: PlannedRow[]): PlanSummary {
  const labels = (): Record<QualityLabel, number> => ({ HIGH: 0, MEDIUM: 0, LOW: 0 });
  const summary: PlanSummary = {
    rows: rows.length,
    labelsBefore: labels(),
    labelsAfter: labels(),
    transitions: {},
    byStatus: {},
    questionSetChanged: 0,
    noPriorBreakdown: 0,
  };
  for (const row of rows) {
    summary.labelsBefore[row.before.label] += 1;
    summary.labelsAfter[row.after.label] += 1;
    const transition = `${row.before.label}->${row.after.label}`;
    summary.transitions[transition] = (summary.transitions[transition] ?? 0) + 1;
    summary.byStatus[row.status] = (summary.byStatus[row.status] ?? 0) + 1;
    if (row.flags.questionSetChanged) summary.questionSetChanged += 1;
    if (row.flags.noPriorBreakdown) summary.noPriorBreakdown += 1;
  }
  return summary;
}

export async function buildPlan(tx: Tx, now = new Date()): Promise<BackfillPlan> {
  const changes = await lastFormChanges(tx);
  const rows = (await readOriginalModelRows(tx)).map((row) => planRow(row, changes.get(row.categoryId)));
  return {
    kind: 'quality-score-v2-plan',
    formatVersion: 1,
    createdAt: now.toISOString(),
    targetVersion: QUALITY_SCORE_VERSION,
    digest: rowsDigest(rows),
    summary: summarize(rows),
    rows,
  };
}

// ── apply ───────────────────────────────────────────────────────────────────

/**
 * Why the plan cannot be applied as it stands, read in the same transaction
 * that would apply it. Empty means every planned row still is what the plan
 * read and still scores what the plan shows.
 */
export async function applyRefusals(tx: Tx, plan: BackfillPlan, confirmDigest: string | null): Promise<string[]> {
  const refusals: string[] = [];
  if (plan.kind !== 'quality-score-v2-plan' || plan.formatVersion !== 1) {
    return ['not a quality-score-v2 plan'];
  }
  if (plan.targetVersion !== QUALITY_SCORE_VERSION) {
    refusals.push(`plan targets model ${plan.targetVersion}; this build is model ${QUALITY_SCORE_VERSION}`);
  }
  if (rowsDigest(plan.rows) !== plan.digest) {
    refusals.push('plan rows do not match the plan digest (the file was edited)');
  }
  if (confirmDigest !== plan.digest) {
    refusals.push('--confirm-digest does not repeat the plan digest');
  }
  if (plan.rows.length === 0) {
    refusals.push('the plan is empty: nothing to apply');
  }

  const current = new Map((await readOriginalModelRows(tx)).map((row) => [row.id, row]));
  const planned = new Set(plan.rows.map((row) => row.id));
  const unplanned = [...current.keys()].filter((id) => !planned.has(id));
  if (unplanned.length > 0) {
    refusals.push(`${unplanned.length} original-model row(s) are not in the plan (re-plan): ${unplanned.slice(0, 5).join(', ')}`);
  }

  for (const row of plan.rows) {
    const stored = current.get(row.id);
    if (!stored) {
      refusals.push(`${row.id}: no longer an original-model row (moved or deleted since the plan)`);
      continue;
    }
    if (stored.qualityScore !== row.before.score || canonicalJson(stored.qualityScoreBreakdown) !== canonicalJson(row.before.breakdown)) {
      refusals.push(`${row.id}: score or breakdown changed since the plan`);
      continue;
    }
    const now = planRow(stored, undefined);
    if (canonicalJson(now.after) !== canonicalJson(row.after)) {
      refusals.push(`${row.id}: scores differently now than in the plan (the form changed; re-plan)`);
    }
  }
  return refusals;
}

export async function applyPlan(tx: Tx, plan: BackfillPlan, confirmDigest: string | null, now = new Date()): Promise<AppliedManifest> {
  const refusals = await applyRefusals(tx, plan, confirmDigest);
  if (refusals.length > 0) throw new BackfillRefused(refusals);

  for (const row of plan.rows) {
    const count = await writeQuality(tx, row.id, row.before, row.after);
    if (count !== 1) throw new BackfillRefused([`${row.id}: guarded write matched ${count} rows`]);
  }

  const left = await tx.serviceRequest.count({ where: { qualityScoreVersion: { lt: QUALITY_SCORE_VERSION } } });
  if (left !== 0) throw new BackfillRefused([`${left} original-model row(s) remain after the apply`]);

  return { kind: 'quality-score-v2-applied', formatVersion: 1, createdAt: now.toISOString(), planDigest: plan.digest, rows: plan.rows };
}

/**
 * The one write, both ways: the three quality columns of one row, only while
 * the row still holds `from`. Raw SQL rather than `updateMany` on purpose —
 * Prisma would stamp `updatedAt`, and the admin shows that as "Güncellendi":
 * re-scoring under a new model is not a change to the request, and must not
 * read as one.
 */
async function writeQuality(
  tx: Tx,
  id: string,
  from: { score: number; version: number },
  to: { score: number; version: number; breakdown: Prisma.JsonValue | null },
): Promise<number> {
  const breakdown = to.breakdown === null ? null : JSON.stringify(to.breakdown);
  return tx.$executeRaw`
    UPDATE "ServiceRequest"
       SET "qualityScore" = ${to.score},
           "qualityScoreVersion" = ${to.version},
           "qualityScoreBreakdown" = ${breakdown}::jsonb
     WHERE "id" = ${id}
       AND "qualityScoreVersion" = ${from.version}
       AND "qualityScore" = ${from.score}`;
}

// ── rollback ────────────────────────────────────────────────────────────────

export async function rollbackRefusals(tx: Tx, manifest: AppliedManifest): Promise<string[]> {
  if (manifest.kind !== 'quality-score-v2-applied' || manifest.formatVersion !== 1) {
    return ['not an applied quality-score-v2 manifest'];
  }
  const refusals: string[] = [];
  const rows = await tx.serviceRequest.findMany({
    where: { id: { in: manifest.rows.map((row) => row.id) } },
    select: { id: true, qualityScore: true, qualityScoreVersion: true, qualityScoreBreakdown: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of manifest.rows) {
    const stored = byId.get(row.id);
    if (!stored) {
      refusals.push(`${row.id}: no longer exists`);
    } else if (
      stored.qualityScoreVersion !== row.after.version ||
      stored.qualityScore !== row.after.score ||
      canonicalJson(stored.qualityScoreBreakdown) !== canonicalJson(row.after.breakdown)
    ) {
      refusals.push(`${row.id}: changed since the apply (recalculated?)`);
    }
  }
  return refusals;
}

export async function applyRollback(tx: Tx, manifest: AppliedManifest, now = new Date()): Promise<AppliedManifest> {
  const refusals = await rollbackRefusals(tx, manifest);
  if (refusals.length > 0) throw new BackfillRefused(refusals);

  for (const row of manifest.rows) {
    const count = await writeQuality(tx, row.id, row.after, row.before);
    if (count !== 1) throw new BackfillRefused([`${row.id}: guarded write matched ${count} rows`]);
  }

  return { ...manifest, kind: 'quality-score-v2-rolled-back', createdAt: now.toISOString() };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

type Command = 'plan' | 'apply' | 'rollback';
const COMMANDS: readonly Command[] = ['plan', 'apply', 'rollback'];

export type Cli = {
  command: Command;
  apply: boolean;
  plan: string | null;
  confirmDigest: string | null;
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
    plan: null,
    confirmDigest: null,
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
    else if (arg === '--plan') cli.plan = value(arg, i++);
    else if (arg === '--confirm-digest') cli.confirmDigest = value(arg, i++).trim().toLowerCase();
    else if (arg === '--manifest') cli.manifest = value(arg, i++);
    else if (arg === '--out') cli.out = value(arg, i++);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (command === 'plan' && cli.apply) throw new Error('plan only reads; it takes no --apply');
  if (command === 'apply' && (!cli.plan || !cli.confirmDigest)) {
    throw new Error('apply needs --plan FILE and --confirm-digest repeating the plan digest');
  }
  if (command === 'rollback' && !cli.manifest) throw new Error('rollback needs --manifest');
  return cli;
}

function writePrivate(dir: string, name: string, body: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return file;
}

function printSummary(summary: PlanSummary): void {
  const labels = (counts: Record<QualityLabel, number>) => `HIGH ${counts.HIGH} / MEDIUM ${counts.MEDIUM} / LOW ${counts.LOW}`;
  console.log(`rows                     : ${summary.rows}`);
  console.log(`labels before            : ${labels(summary.labelsBefore)}`);
  console.log(`labels after             : ${labels(summary.labelsAfter)}`);
  console.log(
    `transitions              : ${Object.entries(summary.transitions).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`,
  );
  console.log(`by status                : ${Object.entries(summary.byStatus).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`);
  console.log(`form changed since sent  : ${summary.questionSetChanged}`);
  console.log(`no prior breakdown       : ${summary.noPriorBreakdown}`);
}

async function readOnly<T>(prisma: PrismaClient, run: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // A dry run cannot write, whatever a future edit to this file does.
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return run(tx);
  }, { timeout: 120_000 });
}

function serializable<T>(prisma: PrismaClient, run: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prisma = new PrismaClient();
  const banner = (what: string) => console.log(`\n=== QUALITY SCORE BACKFILL v${QUALITY_SCORE_VERSION} — ${cli.command.toUpperCase()} — ${what} ===\n`);
  const refused = (refusals: string[]) => {
    console.log('refusals:');
    for (const refusal of refusals) console.log(`  - ${refusal}`);
    process.exitCode = 2;
  };

  try {
    if (cli.command === 'plan') {
      banner('READ ONLY');
      const plan = await readOnly(prisma, (tx) => buildPlan(tx));
      printSummary(plan.summary);
      console.log(`digest                   : ${plan.digest}`);
      const file = writePrivate(cli.out, `quality-score-v2-${stamp}-plan.json`, plan);
      console.log(`\nplan written to ${file} (mode 0600)`);
      return;
    }

    if (cli.command === 'apply') {
      const plan = JSON.parse(readFileSync(cli.plan!, 'utf8')) as BackfillPlan;
      if (!cli.apply) {
        banner('DRY RUN (nothing changed)');
        const refusals = await readOnly(prisma, (tx) => applyRefusals(tx, plan, cli.confirmDigest));
        if (refusals.length > 0) refused(refusals);
        else {
          printSummary(plan.summary);
          console.log('\nno refusals: --apply would move exactly these rows');
        }
        return;
      }
      const applied = await serializable(prisma, (tx) => applyPlan(tx, plan, cli.confirmDigest));
      banner('APPLIED');
      printSummary(plan.summary);
      const file = writePrivate(cli.out, `quality-score-v2-${stamp}-applied.json`, applied);
      console.log(`\nmanifest written to ${file} (mode 0600; rollback reads it)`);
      return;
    }

    const manifest = JSON.parse(readFileSync(cli.manifest!, 'utf8')) as AppliedManifest;
    if (!cli.apply) {
      banner('DRY RUN (nothing changed)');
      const refusals = await readOnly(prisma, (tx) => rollbackRefusals(tx, manifest));
      if (refusals.length > 0) refused(refusals);
      else console.log(`no refusals: --apply would restore ${manifest.rows.length} row(s)`);
      return;
    }
    const rolledBack = await serializable(prisma, (tx) => applyRollback(tx, manifest));
    banner('ROLLED BACK');
    const file = writePrivate(cli.out, `quality-score-v2-${stamp}-rolled-back.json`, rolledBack);
    console.log(`${rolledBack.rows.length} row(s) restored; manifest written to ${file} (mode 0600)`);
  } catch (error) {
    if (error instanceof BackfillRefused) {
      banner('REFUSED (nothing changed)');
      refused(error.refusals);
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      banner('CONFLICT (nothing changed)');
      console.log('another transaction changed these rows at the same time; run the plan again');
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
