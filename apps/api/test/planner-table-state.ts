import type { PrismaClient } from '@prisma/client';

/**
 * Rebuilds the tables a statement reads, for a spec about the plan PostgreSQL
 * makes for it (CI-PERF-005).
 *
 * The planner prices an index by its pages on disk, and by how many rows the
 * last ANALYZE saw. TRUNCATE gives every spec empty files, but the delete reset
 * (TEST_DB_RESET=delete) leaves the pages behind: after a few hundred earlier
 * cases on one database `ProviderProfile_phone_idx` had 38 pages with four rows,
 * or 23 with one, depending on when autovacuum ran. That turned
 * "exact phone spellings use the B-tree" into a coin toss between two indexes.
 * The rebuild puts those specs back on compact files in either mode.
 */
export async function rebuildTablesOf(db: Pick<PrismaClient, '$executeRawUnsafe'>, query: string): Promise<void> {
  const tables = new Set([...query.matchAll(/(?:FROM|JOIN) "public"\."([A-Za-z0-9_]+)"/g)].map((match) => match[1]!));
  for (const table of tables) {
    // Outside any transaction, which VACUUM refuses. The name matched the pattern above.
    await db.$executeRawUnsafe(`VACUUM (FULL) "public"."${table}"`);
  }
}
