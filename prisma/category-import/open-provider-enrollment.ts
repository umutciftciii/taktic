import type { PrismaClient } from '@prisma/client';
import { ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import type { CategoryWave } from './types';

/**
 * Opens an already-imported wave's draft services to provider applications.
 *
 * This exists because of a gap the importer creates on purpose. The import
 * writes `providerEnrollmentOpen` only when it *creates* a category — the same
 * rule it applies to the price and the status — so that an operator who closed
 * a draft to applications keeps it closed through the next run. That rule is
 * right, and it means a wave imported before the column existed stays closed
 * forever: the definitions say `true`, the rows say `false`, and no run of the
 * importer will ever reconcile them.
 *
 * So the reconciliation is a separate, named act. Not a widening of the
 * importer — which would undo an operator's decision every time somebody ran it
 * — but a command a person chooses to run once, against one wave, whose whole
 * effect is stated in its name.
 *
 * It is deliberately not SQL. A hand-written UPDATE against a slug list is a
 * thing nobody can test, nobody reviews twice, and which silently does the
 * wrong thing the day a slug is renamed.
 */

export type EnrollmentOpenSummary = {
  /** Slugs the allow-list named. */
  targeted: number;
  /** Rows this run flipped from closed to open. Zero on a second run. */
  opened: number;
  /** Rows that were already open — the idempotent case, reported not hidden. */
  alreadyOpen: number;
  /**
   * Rows present under an allow-listed slug that this command must not touch:
   * a service somebody released, closed, or turned into a group or a router.
   */
  skipped: number;
  /** Allow-listed slugs with no row behind them — a wave not imported here. */
  missing: number;
  /** The slugs actually opened, so a run says what it did rather than how much. */
  openedSlugs: string[];
};

/**
 * The canonical allow-list: every draft service a wave defines.
 *
 * Derived from the wave definitions rather than copied beside them, so a slug
 * renamed in one place cannot go stale in the other. Groups and routers are
 * excluded here as well as at the write below — neither describes work anybody
 * performs, so neither is ever something a provider signs up for.
 */
export function waveEnrollmentSlugs(...waves: CategoryWave[]): string[] {
  const slugs = new Set<string>();

  for (const wave of waves) {
    for (const definition of wave.categories) {
      if (
        definition.kind === ServiceCategoryKind.LEAF &&
        definition.status === ServiceCategoryStatus.DRAFT &&
        definition.providerEnrollmentOpen === true
      ) {
        slugs.add(definition.slug);
      }
    }
  }

  return [...slugs];
}

/**
 * Opens exactly the allow-listed slugs that are still draft services.
 *
 * The kind and status guard is repeated on the write and not only on the read
 * above it. The read is how the summary can tell "already open" from "not mine
 * to touch"; the write is what makes the guarantee hold — a category released
 * between the two statements is not opened by a decision taken a moment before
 * it stopped being a draft.
 *
 * Idempotent because the write asks for rows that are still closed: a second
 * run matches nothing and reports zero.
 */
export async function openProviderEnrollment(
  prisma: PrismaClient,
  slugs: readonly string[],
): Promise<EnrollmentOpenSummary> {
  if (slugs.length === 0) {
    return { targeted: 0, opened: 0, alreadyOpen: 0, skipped: 0, missing: 0, openedSlugs: [] };
  }

  return prisma.$transaction(async (tx) => {
    const rows = await tx.serviceCategory.findMany({
      where: { slug: { in: [...slugs] } },
      select: { slug: true, kind: true, status: true, providerEnrollmentOpen: true },
    });

    const draftServices = rows.filter(
      (row) =>
        row.kind === ServiceCategoryKind.LEAF && row.status === ServiceCategoryStatus.DRAFT,
    );
    const closed = draftServices.filter((row) => !row.providerEnrollmentOpen);

    const { count } = await tx.serviceCategory.updateMany({
      where: {
        slug: { in: closed.map((row) => row.slug) },
        kind: ServiceCategoryKind.LEAF,
        status: ServiceCategoryStatus.DRAFT,
        providerEnrollmentOpen: false,
      },
      data: { providerEnrollmentOpen: true },
    });

    return {
      targeted: slugs.length,
      opened: count,
      alreadyOpen: draftServices.length - closed.length,
      skipped: rows.length - draftServices.length,
      missing: slugs.length - rows.length,
      openedSlugs: closed.map((row) => row.slug).sort(),
    };
  });
}
