import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * REL-002: the request ↔ match-round consistency check, run from the
 * very file operators run (`scripts/ops/rel-002-round-consistency.sql`), so the
 * suite and the runbook can never check two different things.
 *
 * Returns one row per violation; an empty list means every request, offer,
 * contact reveal and message thread agrees with its round. Test/preflight only:
 * it reads every request.
 */
export type RoundInconsistency = { requestId: string; check: string; detail: string };

const CONSISTENCY_SQL = readFileSync(
  resolve(__dirname, '../../../scripts/ops/rel-002-round-consistency.sql'),
  'utf8',
);

export async function roundInconsistencies(prisma: PrismaClient): Promise<RoundInconsistency[]> {
  return prisma.$queryRawUnsafe<RoundInconsistency[]>(CONSISTENCY_SQL);
}
