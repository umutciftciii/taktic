import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * CAMPAIGN-ENTITLEMENT-001 — the read-only consistency check operators run
 * (`scripts/ops/campaign-entitlement-001-consistency.sql`), run by the suite
 * after every allowance case so the file and the code cannot drift apart.
 */
export type AllowanceInconsistency = { check: string; subject: string };

const CONSISTENCY_SQL = readFileSync(
  resolve(__dirname, '../../../scripts/ops/campaign-entitlement-001-consistency.sql'),
  'utf8',
);

export async function allowanceInconsistencies(prisma: PrismaClient): Promise<AllowanceInconsistency[]> {
  return prisma.$queryRawUnsafe<AllowanceInconsistency[]>(CONSISTENCY_SQL);
}
