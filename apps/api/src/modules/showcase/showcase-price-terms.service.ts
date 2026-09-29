import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListShowcasePriceTermsDto, showcaseAdminPage } from './dto/admin-showcase-list.dto';

/**
 * The operator's view of who agreed to which price-responsibility text.
 *
 * ## Two tables, one ledger
 *
 * There are two kinds of acceptance row, from two eras of the sale, and both
 * are records of consent that stay exactly as they were written:
 *
 * - `ShowcaseCardPriceTermsAcceptance` — keyed to a *card*, from the card-bound
 *   sale. No route writes one any more; the rows are what every legacy run was
 *   sold under, and what its public card still shows.
 * - `ShowcasePackageTermsAcceptance` — keyed to the *business* and a version,
 *   written by the package-first checkout the first time a provider buys under
 *   a given version of the terms.
 *
 * The operator asks one historical question — "what did this business agree
 * to, and when" — and the answer has to cover both, so this merges them and
 * labels each row with its `scope`.
 *
 * ## Append-only
 *
 * There is no update and no delete here, and there is no admin route that
 * writes one either. A record of consent that can be edited afterwards is not a
 * record of consent.
 */
@Injectable()
export class ShowcasePriceTermsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every version ever accepted, not just the one in force: a list narrowed to
   * today's terms would make the table's whole reason for existing invisible.
   *
   * `cardId` applies to the card-bound rows only; a package-bound acceptance
   * names no card, so a list filtered by card is by definition card-bound.
   *
   * ## One ledger, paged on the server (API-HARDENING-001)
   *
   * This used to read the newest 200 rows of each table and merge them, so an
   * older acceptance was unreachable and a count past 200 was a guess. The two
   * tables are now ordered together in the database — one UNION ALL over
   * (scope, id, acceptedAt), newest first with `id` as the tie-break — and
   * only the requested page is loaded in full. `total` is exact for the
   * filter, and `versions` counts every version under the provider/card scope
   * without the version filter, so the screen's tabs neither shrink to the
   * chosen version nor depend on which page is open.
   *
   * Everything runs in one REPEATABLE READ transaction: the page, the total
   * and the counts describe the same moment.
   */
  async listForAdmin(filters: ListShowcasePriceTermsDto) {
    const { page, pageSize, skip } = showcaseAdminPage(filters);
    const scope = {
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
    };
    const cardScope = { ...scope, ...(filters.cardId ? { cardId: filters.cardId } : {}) };
    const version = filters.termsVersion ? { termsVersion: filters.termsVersion } : {};
    const includePackages = !filters.cardId;

    return this.prisma.$transaction(
      async (tx) => {
        const cardConditions = sqlConditions({ ...cardScope, ...version });
        const packageConditions = sqlConditions({ ...scope, ...version });
        const packagePart = includePackages
          ? Prisma.sql`UNION ALL SELECT 'PACKAGE' AS "scope", "id", "acceptedAt" FROM "ShowcasePackageTermsAcceptance" ${packageConditions}`
          : Prisma.empty;

        const pageKeys = await tx.$queryRaw<Array<{ scope: 'CARD' | 'PACKAGE'; id: string }>>`
          SELECT "scope", "id" FROM (
            SELECT 'CARD' AS "scope", "id", "acceptedAt" FROM "ShowcaseCardPriceTermsAcceptance" ${cardConditions}
            ${packagePart}
          ) AS "merged"
          ORDER BY "acceptedAt" DESC, "id" DESC, "scope" ASC
          LIMIT ${pageSize} OFFSET ${skip}`;

        const cardIds = pageKeys.filter((key) => key.scope === 'CARD').map((key) => key.id);
        const packageIds = pageKeys.filter((key) => key.scope === 'PACKAGE').map((key) => key.id);

        const [cardRows, packageRows, cardTotal, packageTotal, cardVersions, packageVersions] = await Promise.all([
          cardIds.length
            ? tx.showcaseCardPriceTermsAcceptance.findMany({ where: { id: { in: cardIds } }, select: cardAcceptanceSelect })
            : [],
          packageIds.length
            ? tx.showcasePackageTermsAcceptance.findMany({
                where: { id: { in: packageIds } },
                select: packageAcceptanceSelect,
              })
            : [],
          tx.showcaseCardPriceTermsAcceptance.count({ where: { ...cardScope, ...version } }),
          includePackages ? tx.showcasePackageTermsAcceptance.count({ where: { ...scope, ...version } }) : 0,
          tx.showcaseCardPriceTermsAcceptance.groupBy({
            by: ['termsVersion'],
            where: cardScope,
            _count: { _all: true },
          }),
          includePackages
            ? tx.showcasePackageTermsAcceptance.groupBy({
                by: ['termsVersion'],
                where: scope,
                _count: { _all: true },
              })
            : [],
        ]);

        const cards = new Map(cardRows.map((row) => [row.id, row]));
        const packages = new Map(packageRows.map((row) => [row.id, row]));
        const acceptances: AdminAcceptance[] = [];
        for (const key of pageKeys) {
          if (key.scope === 'CARD') {
            const row = cards.get(key.id);
            if (row) acceptances.push({ ...row, scope: 'CARD' });
          } else {
            const row = packages.get(key.id);
            if (row) acceptances.push({ ...row, cardId: null, card: null, scope: 'PACKAGE' });
          }
        }

        const versionCounts = new Map<string, number>();
        for (const row of [...cardVersions, ...packageVersions]) {
          versionCounts.set(row.termsVersion, (versionCounts.get(row.termsVersion) ?? 0) + row._count._all);
        }
        const total = cardTotal + packageTotal;

        return {
          acceptances,
          total,
          page,
          pageSize,
          hasNextPage: skip + acceptances.length < total,
          versions: [...versionCounts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([termsVersion, count]) => ({ termsVersion, count })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

/** The only columns a filter may name. The values are always bound parameters. */
const FILTER_COLUMNS = new Set(['providerId', 'cardId', 'termsVersion']);

/** `WHERE "col" = $1 AND …` for the equality filters above, or nothing. */
function sqlConditions(filters: Record<string, string | undefined>) {
  const conditions = Object.entries(filters)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([column, value]) => {
      if (!FILTER_COLUMNS.has(column)) {
        throw new Error(`Unexpected price-terms filter column: ${column}`);
      }
      return Prisma.sql`${Prisma.raw(`"${column}"`)} = ${value}`;
    });
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

type CardAcceptanceRow = Prisma.ShowcaseCardPriceTermsAcceptanceGetPayload<{ select: typeof cardAcceptanceSelect }>;
type PackageAcceptanceRow = Prisma.ShowcasePackageTermsAcceptanceGetPayload<{
  select: typeof packageAcceptanceSelect;
}>;
type AdminAcceptance =
  | (CardAcceptanceRow & { scope: 'CARD' })
  | (PackageAcceptanceRow & { cardId: null; card: null; scope: 'PACKAGE' });

const cardAcceptanceSelect = {
  id: true,
  cardId: true,
  providerId: true,
  termsVersion: true,
  termsTextSnapshot: true,
  acceptedAt: true,
  provider: { select: { id: true, businessName: true, status: true } },
  card: { select: { id: true, kind: true, status: true, categoryId: true } },
  acceptedByUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ShowcaseCardPriceTermsAcceptanceSelect;

const packageAcceptanceSelect = {
  id: true,
  providerId: true,
  termsVersion: true,
  termsTextSnapshot: true,
  acceptedAt: true,
  provider: { select: { id: true, businessName: true, status: true } },
  acceptedByUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ShowcasePackageTermsAcceptanceSelect;
