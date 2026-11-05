import type { PrismaClient } from '@prisma/client';

type RawSql = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;
type PlanNode = Record<string, unknown>;

/** What identifies the files of each named table of the public schema; a name that is no such table is absent. */
async function filenodes(db: RawSql, tables: readonly string[]): Promise<Map<string, string>> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string; node: string }>>(
    `SELECT c.relname AS name, c.relfilenode::text AS node
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
    tables,
  );
  return new Map(rows.map((row) => [row.name, row.node]));
}

/**
 * Rebuilds the named tables, for a spec about the plan PostgreSQL makes for a
 * statement (CI-PERF-005, CI-HARDEN-001).
 *
 * The planner prices an index by its pages on disk, and by how many rows the
 * last ANALYZE saw. TRUNCATE gives every spec empty files, but the delete reset
 * (TEST_DB_RESET=delete) leaves the pages behind: after a few hundred earlier
 * cases on one database `ProviderProfile_phone_idx` had 38 pages with four rows,
 * or 23 with one, depending on when autovacuum ran. That turned
 * "exact phone spellings use the B-tree" into a coin toss between two indexes.
 * The rebuild puts those specs back on compact files in either mode.
 *
 * Everything short of a rebuild is an error, because a spec that went on would
 * pass or fail on whatever files it found. That includes VACUUM's own quiet
 * failure: on a table it may not touch it warns and returns normally, so the
 * proof is that the table's files changed, not that nothing was thrown.
 */
export async function rebuildTables(db: RawSql, tables: readonly string[]): Promise<void> {
  if (tables.length === 0) throw new Error('rebuildTables: no tables to rebuild');
  const names = [...new Set(tables)];
  const before = await filenodes(db, names);
  const unknown = names.filter((name) => !before.has(name));
  if (unknown.length > 0) throw new Error(`rebuildTables: ${JSON.stringify(unknown)} are not tables of the public schema`);

  for (const name of names) {
    // Outside any transaction, which VACUUM refuses. The name was found in the catalog above.
    await db.$executeRawUnsafe(`VACUUM (FULL) "public"."${name.replaceAll('"', '""')}"`);
  }

  const after = await filenodes(db, names);
  for (const name of names) {
    if (after.get(name) === before.get(name)) throw new Error(`rebuildTables: "${name}" was not rebuilt`);
  }
}

/** The plan's node types and index names, flattened. */
function planNodes(node: PlanNode, out: string[] = []): string[] {
  out.push(String(node['Node Type']));
  if (node['Index Name']) out.push(String(node['Index Name']));
  for (const child of (node.Plans as PlanNode[] | undefined) ?? []) planNodes(child, out);
  return out;
}

/** Every table the plan reads, subqueries included: they are children like any other. */
function planRelations(node: PlanNode, out = new Set<string>()): Set<string> {
  if (node['Relation Name']) out.add(String(node['Relation Name']));
  for (const child of (node.Plans as PlanNode[] | undefined) ?? []) planRelations(child, out);
  return out;
}

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

/**
 * The plan PostgreSQL makes for a recorded statement when it may only use bitmap
 * index scans, on freshly rebuilt `tables`. Seq Scan stays possible as the
 * planner's last resort, so a plan without one proves every arm of the WHERE is
 * served by an index.
 *
 * `tables` is written out by the spec and must be exactly what PostgreSQL says
 * the statement reads. A table left out means a result resting on files nobody
 * rebuilt; a table too many means a list that no longer describes the statement.
 */
export async function bitmapOnlyPlan(
  db: RawSql & Pick<PrismaClient, '$transaction'>,
  statement: { query: string; params: string },
  tables: readonly string[],
): Promise<string[]> {
  await rebuildTables(db, tables);
  const plan = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_indexonlyscan = off');
    const [row] = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
      `EXPLAIN (FORMAT JSON) ${statement.query}`,
      ...(JSON.parse(statement.params) as unknown[]),
    );
    return row!['QUERY PLAN'][0]!.Plan;
  });

  const read = planRelations(plan);
  const unlisted = [...read].filter((name) => !tables.includes(name));
  const unread = tables.filter((name) => !read.has(name));
  if (unlisted.length > 0) throw new Error(`bitmapOnlyPlan: the plan reads ${quoted(unlisted)}, not in the list`);
  if (unread.length > 0) throw new Error(`bitmapOnlyPlan: the plan does not read ${quoted(unread)}, in the list`);
  return planNodes(plan);
}
