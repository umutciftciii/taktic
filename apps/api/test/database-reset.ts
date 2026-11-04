import type { PrismaClient } from '@prisma/client';
import { assertIsTestDatabaseName } from './test-database';

/**
 * Empties the tables a spec may have written to, by one of two equivalent means
 * (CI-PERF-004; the analysis is in
 * docs/superpowers/specs/2026-11-04-ci-perf-004-db-test-reset.md).
 *
 *   TEST_DB_RESET=truncate   the statement this suite has always run. Default.
 *   TEST_DB_RESET=delete     one DO block: same tables, same locks, same sequence
 *                            state, in about 2 ms instead of about 90.
 *
 * What is deleted is computed, not listed. The harness names a few tables and
 * TRUNCATE ... CASCADE reaches everything that references them, so the set a
 * TRUNCATE empties is the foreign-key closure of that list: 112 tables for a
 * list of 99. A DELETE of the list alone would leave rows in the other 13, and
 * with foreign keys off they would point at nothing.
 *
 * Any failure here stops the file: see `run`. A spec that starts from somebody
 * else's rows fails somewhere unrelated, or worse, passes.
 */

export const RESET_MODES = ['truncate', 'delete'] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/** An unset or blank value is the default. Anything else unknown stops the run. */
export function resolveResetMode(raw: string | undefined = process.env.TEST_DB_RESET): ResetMode {
  const value = raw?.trim();
  if (!value) {
    return 'truncate';
  }
  if (!(RESET_MODES as readonly string[]).includes(value)) {
    throw new Error(`TEST_DB_RESET must be one of ${RESET_MODES.join(', ')}; got "${value}".`);
  }
  return value as ResetMode;
}

export type ResetClient = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export type ResetConfig = {
  mode: ResetMode;
  /** The tables named directly. Everything referencing them is reached from here. */
  seeds: readonly string[];
  /** Tables of `schema` no reset may touch. Their row counts are watched instead. */
  keep: readonly string[];
  schema?: string;
  /** Runs before anything touches the database. */
  beforeReset?: () => Promise<unknown>;
  /** Puts back rows a fresh database has. Runs after the residue check. */
  afterReset?: (db: ResetClient) => Promise<unknown>;
};

export type ResetPlan = {
  statement: string;
  tables: string[];
  sequences: string[];
  keptRowsQuery: string;
  keptRowsBaseline: string;
  residueQuery: string;
};

const DELETE_BLOCK_TAG = '$reset$';

/** Whether a statement is the one that empties the tables, in either mode. */
export function isResetStatement(statement: string): boolean {
  return statement.startsWith('TRUNCATE') || statement.startsWith(`DO ${DELETE_BLOCK_TAG}`);
}

function ident(...parts: string[]): string {
  return parts.map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

type CatalogTable = {
  schema: string;
  name: string;
  kind: string;
  reached: boolean;
  inherits: boolean;
  rowSecurity: boolean;
  canTruncate: boolean;
  canDelete: boolean;
  /** Triggers session_replication_role = replica would not silence. */
  replicaProofTriggers: number;
  truncateTriggers: number;
  rules: number;
};

/**
 * Every table of the schema, plus anything elsewhere the closure reaches, with
 * what it takes to know a DELETE does to that table what a TRUNCATE would.
 */
const CATALOG_TABLES = `
  WITH RECURSIVE reached(oid) AS (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p', 'f')
    UNION
    SELECT con.conrelid FROM pg_constraint con JOIN reached r ON con.confrelid = r.oid
     WHERE con.contype = 'f'
  )
  SELECT n.nspname AS "schema", c.relname AS "name", c.relkind::text AS "kind",
         c.oid IN (SELECT oid FROM reached) AS "reached",
         c.relhassubclass OR c.relispartition AS "inherits",
         c.relrowsecurity AS "rowSecurity",
         has_table_privilege(c.oid, 'TRUNCATE') AS "canTruncate",
         has_table_privilege(c.oid, 'DELETE') AS "canDelete",
         (SELECT count(*)::int FROM pg_trigger t
           WHERE t.tgrelid = c.oid AND t.tgenabled IN ('A', 'R')) AS "replicaProofTriggers",
         (SELECT count(*)::int FROM pg_trigger t
           WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND (t.tgtype & 32) <> 0) AS "truncateTriggers",
         (SELECT count(*)::int FROM pg_rewrite r
           WHERE r.ev_class = c.oid AND r.rulename <> '_RETURN') AS "rules"
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'f')
     AND (n.nspname = $1 OR c.oid IN (SELECT oid FROM reached))
   ORDER BY 1, 2`;

/** The sequences RESTART IDENTITY restarts: those a column of a reached table owns. */
const CATALOG_SEQUENCES = `
  WITH RECURSIVE reached(oid) AS (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p', 'f')
    UNION
    SELECT con.conrelid FROM pg_constraint con JOIN reached r ON con.confrelid = r.oid
     WHERE con.contype = 'f'
  )
  SELECT n.nspname AS "schema", s.relname AS "name", pg_has_role(s.relowner, 'USAGE') AS "owned"
    FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    JOIN pg_namespace n ON n.oid = s.relnamespace
   WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
     AND d.deptype IN ('a', 'i') AND d.refobjid IN (SELECT oid FROM reached)
   ORDER BY 1, 2`;

function names(tables: CatalogTable[]): string {
  return tables.map((table) => `${table.schema}.${table.name}`).join(', ');
}

/**
 * Establishes, once per client, that this is a test database and exactly what a
 * reset of it means. Reads only; nothing has been written when this throws.
 */
export async function loadResetPlan(db: ResetClient, config: ResetConfig): Promise<ResetPlan> {
  const schema = config.schema ?? 'public';
  const refuse = (reason: string) => new Error(`Refusing to reset the database: ${reason}`);

  // The URL was checked at startup; this asks the server what it actually is,
  // and is what stops a client built from some other URL.
  const [target] = await db.$queryRawUnsafe<{ database: string; inRecovery: boolean }[]>(
    `SELECT current_database() AS "database", pg_is_in_recovery() AS "inRecovery"`,
  );
  assertIsTestDatabaseName(target!.database);
  if (target!.inRecovery) {
    throw refuse(`"${target!.database}" is a read-only standby.`);
  }

  const seeds = [...config.seeds];
  const catalog = await db.$queryRawUnsafe<CatalogTable[]>(CATALOG_TABLES, schema, seeds);
  const sequences = await db.$queryRawUnsafe<{ schema: string; name: string; owned: boolean }[]>(
    CATALOG_SEQUENCES,
    schema,
    seeds,
  );

  const inSchema = catalog.filter((table) => table.schema === schema);
  const missing = [...config.seeds, ...config.keep].filter(
    (name) => !inSchema.some((table) => table.name === name),
  );
  if (missing.length > 0) {
    throw refuse(`these tables are named but do not exist: ${missing.join(', ')}.`);
  }

  const tables = catalog.filter((table) => table.reached);
  const kept = inSchema.filter((table) => config.keep.includes(table.name));
  const contradicted = kept.filter((table) => table.reached);
  if (contradicted.length > 0) {
    throw refuse(`${names(contradicted)} must be kept, but a TRUNCATE ... CASCADE would empty them.`);
  }
  const unclassified = inSchema.filter(
    (table) => !table.reached && !config.keep.includes(table.name),
  );
  if (unclassified.length > 0) {
    throw refuse(
      `nothing would empty ${names(unclassified)}, so rows would leak between cases. ` +
        'Add each to the reset list in apps/api/test/harness.ts.',
    );
  }

  const forbidden = (privilege: 'canTruncate' | 'canDelete') =>
    tables.filter((table) => !table[privilege]);
  const privilege = config.mode === 'truncate' ? 'canTruncate' : 'canDelete';
  if (forbidden(privilege).length > 0) {
    throw refuse(
      `this role lacks ${config.mode.toUpperCase()} on ${names(forbidden(privilege))}.`,
    );
  }
  const notOwned = sequences.filter((sequence) => !sequence.owned);
  if (notOwned.length > 0) {
    throw refuse(`this role cannot restart ${notOwned.map((s) => s.name).join(', ')}.`);
  }

  if (config.mode === 'delete') {
    await assertDeleteMatchesTruncate(db, tables, refuse);
  }

  const sequenceIds = sequences.map((sequence) => ident(sequence.schema, sequence.name));
  const seedIds = config.seeds.map((table) => ident(schema, table));
  // In TRUNCATE's lock order: what it names, in that order, then what it reaches.
  const reachedIds = tables.map((table) => ident(table.schema, table.name));
  const tableIds = [...seedIds, ...reachedIds.filter((id) => !seedIds.includes(id))];
  const keptIds = kept.map((table) => [table.name, ident(table.schema, table.name)] as const);

  const keptRowsQuery =
    `SELECT current_setting('session_replication_role') AS "role", ` +
    `jsonb_build_object(${keptIds
      .map(([name, id]) => `${literal(name)}, (SELECT count(*) FROM ${id})`)
      .join(', ')})::text AS "rows"`;
  const [baseline] = await db.$queryRawUnsafe<{ rows: string }[]>(keptRowsQuery);

  return {
    statement:
      config.mode === 'truncate'
        ? `TRUNCATE TABLE ${seedIds.join(', ')} RESTART IDENTITY CASCADE;`
        : deleteBlock(tableIds, sequenceIds),
    tables: tables.map((table) => table.name),
    sequences: sequences.map((sequence) => sequence.name),
    keptRowsQuery,
    keptRowsBaseline: baseline!.rows,
    residueQuery:
      `SELECT "table" FROM (${tables
        .map(
          (table) =>
            `SELECT ${literal(`${table.schema}.${table.name}`)} AS "table" ` +
            `WHERE EXISTS (SELECT 1 FROM ${ident(table.schema, table.name)})`,
        )
        .join(' UNION ALL ')}) AS residue`,
  };
}

/**
 * Everything that would make the DELETE block mean something other than the
 * TRUNCATE. None exists today; a schema change that adds one stops `delete`
 * instead of quietly changing what a clean database is.
 */
async function assertDeleteMatchesTruncate(
  db: ResetClient,
  tables: CatalogTable[],
  refuse: (reason: string) => Error,
): Promise<void> {
  const [{ allowed }] = (await db.$queryRawUnsafe<{ allowed: boolean }[]>(
    `SELECT has_parameter_privilege('session_replication_role', 'SET') AS "allowed"`,
  )) as [{ allowed: boolean }];
  if (!allowed) {
    throw refuse(
      'TEST_DB_RESET=delete needs a superuser, or GRANT SET ON PARAMETER ' +
        'session_replication_role, and this role has neither. Use TEST_DB_RESET=truncate.',
    );
  }

  const checks: [string, (table: CatalogTable) => boolean][] = [
    ['are not plain tables', (table) => table.kind !== 'r' || table.inherits],
    ['have row security', (table) => table.rowSecurity],
    ['have triggers replica mode does not silence', (table) => table.replicaProofTriggers > 0],
    ['have ON TRUNCATE triggers a DELETE would not fire', (table) => table.truncateTriggers > 0],
    ['have rules', (table) => table.rules > 0],
  ];
  for (const [problem, applies] of checks) {
    const hit = tables.filter(applies);
    if (hit.length > 0) {
      throw refuse(`TEST_DB_RESET=delete cannot match TRUNCATE: ${names(hit)} ${problem}.`);
    }
  }
}

/**
 * One statement, so one transaction and one round trip, and SET LOCAL cannot
 * outlive it: replica mode ends with this block on commit and on failure alike,
 * and the pooled connection goes back with its triggers on.
 *
 * ACCESS EXCLUSIVE is what TRUNCATE takes. A writer still in flight is waited
 * for, so its rows are deleted rather than committed behind the DELETE's back.
 */
function deleteBlock(tables: string[], sequences: string[]): string {
  return [
    `DO ${DELETE_BLOCK_TAG} BEGIN`,
    'SET LOCAL session_replication_role = replica;',
    `LOCK TABLE ${tables.join(', ')} IN ACCESS EXCLUSIVE MODE;`,
    ...tables.map((table) => `DELETE FROM ${table};`),
    ...sequences.map((sequence) => `ALTER SEQUENCE ${sequence} RESTART;`),
    `END ${DELETE_BLOCK_TAG}`,
  ].join('\n');
}

function isDeadlock(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta;
  return meta?.code === '40P01' || (error instanceof Error && error.message.includes('40P01'));
}

export function createDatabaseReset(config: ResetConfig) {
  const plans = new WeakMap<object, ResetPlan>();
  let failure: Error | undefined;

  async function planFor(db: ResetClient): Promise<ResetPlan> {
    let plan = plans.get(db);
    if (!plan) {
      plan = await loadResetPlan(db, config);
      plans.set(db, plan);
    }
    return plan;
  }

  async function attempt(db: ResetClient): Promise<void> {
    await config.beforeReset?.();

    const plan = await planFor(db);

    const [before] = await db.$queryRawUnsafe<{ role: string; rows: string }[]>(plan.keptRowsQuery);
    if (before!.role !== 'origin') {
      throw new Error(
        `This connection is in session_replication_role=${before!.role}: triggers and foreign keys ` +
          'are off for every statement on it. Some earlier statement used SET rather than SET LOCAL.',
      );
    }
    if (before!.rows !== plan.keptRowsBaseline) {
      throw new Error(
        `A table no reset clears has changed: ${plan.keptRowsBaseline} became ${before!.rows}. ` +
          'Those rows would reach every later case.',
      );
    }

    try {
      await db.$executeRawUnsafe(plan.statement);
    } catch (error) {
      if (isDeadlock(error)) {
        throw new Error(
          'resetDatabase deadlocked with another database session. Background work that is not a ' +
            'BackgroundWorkOwner (src/common/background-work.ts) is still running from an earlier case.',
          { cause: error },
        );
      }
      throw error;
    }

    // After the commit, not inside it: a write that starts once the reset's locks
    // are gone is the one thing the locks cannot stop, and only a look from
    // outside can see it.
    const residue = await db.$queryRawUnsafe<{ table: string }[]>(plan.residueQuery);
    if (residue.length > 0) {
      throw new Error(
        `Rows survived the reset in ${residue.map((row) => row.table).join(', ')}. Something is still ` +
          'writing, or a table is not what the reset plan believes it is.',
      );
    }

    await config.afterReset?.(db);
  }

  return {
    planFor,
    /**
     * Resets, or fails for good. Vitest carries on after a failed `beforeEach`,
     * so the failure is remembered: every later reset in this worker throws
     * without touching the database, and no case can start from a state that was
     * not established. A failed `beforeEach` keeps its own case from running.
     */
    async run(db: ResetClient): Promise<void> {
      if (failure) {
        throw new Error(
          `An earlier database reset failed, so nothing after it can trust the database: ${failure.message}`,
          { cause: failure },
        );
      }
      try {
        await attempt(db);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
      }
    },
  };
}
