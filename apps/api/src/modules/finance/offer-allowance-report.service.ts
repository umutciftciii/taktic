import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OfferAllowanceReportDto, OfferAllowanceReportGroupBy } from './dto/offer-allowance-report.dto';
import { isValidIsoDate, parseIstanbulDayEnd, parseIstanbulDayStart } from './finance.service';

/**
 * SHOWCASE-ALLOWANCE-002 — the finance report of free vitrin offers.
 *
 * Read-only: nothing here writes, and nothing here changes how a slot is spent,
 * refunded or counted elsewhere. Four sections, each on its own clock, and the
 * response says which clock each one reads:
 *
 * - **cohort** — the grants whose run started in the window
 *   (`OfferAllowanceGrant.validFrom`, the placement's `startAt`). Every grant
 *   splits into `defined = usedTracked + usedLegacy + remainingUsable +
 *   remainingUnusable`, exactly, row by row.
 *     - `usedTracked`: slots with a usage row (any time, not only in the window);
 *     - `usedLegacy`: `quotaUsed − usage rows`, the answers counted at rollout
 *       under the old unlimited rule. They have no category snapshot, so they
 *       get no credit value and no TL value — never an invented one;
 *     - `remainingUsable`: an ACTIVE grant whose run can still bring leads
 *       (PENDING_ACTIVATION / ACTIVE before `endAt`, or SUSPENDED) keeps all of
 *       its remainder; an ended run keeps at most one slot per lead still
 *       waiting for its owner's free answer (the spend path's own binding:
 *       lead OPEN / BREACHED, request gated to the owner, SUBMITTED / APPROVED,
 *       current round DIRECT_SHOWCASE). `remainingUsableViaOpenLeads` is that
 *       second part;
 *     - `remainingUnusable`: the rest, and the whole remainder of a VOID grant.
 *       `remainingVoided` is that last part on its own (SHOWCASE-ALLOWANCE-004):
 *       a subset of `remainingUnusable`, never a fifth term of the sum.
 * - **usage** — the usage rows consumed in the window (`consumedAt`), their
 *   category credit (`listCreditCostSnapshot`, the price at the moment of use)
 *   and its indicative TL value.
 * - **unplaced** — vitrin rights sold (purchase PAID) but not yet placed, by
 *   the right's `grantedAt`. They have no grant yet, so they are never added to
 *   the cohort; a right has no category until it is placed, so the section is
 *   absent under a category filter.
 * - **integrity** — the placements of the window born without a grant: sold
 *   with 0 free offers (SHOWCASE-ALLOWANCE-003, expected) or older than the
 *   allowances (pre-rollout runs that had ended).
 *
 * The indicative TL value of a used slot is its credits × the weighted TL per
 * credit of the PAID one-time credit package purchases of the same Istanbul
 * calendar month (`Σ priceAmountSnapshot / Σ creditAmountSnapshot`): history is
 * valued at its own month's prices, never re-valued at today's. A month with no
 * such purchase has no rate and its credits stay unvalued (N/A). Each usage row
 * is rounded to whole kuruş once, so every breakdown sums to the total exactly.
 * The current list price is returned beside it as a separate reference. Neither
 * is revenue, a collection or a certain loss.
 *
 * Every section is read in one REPEATABLE READ snapshot, so an offer committed
 * while the report runs is either in all of its figures or in none.
 */

const DEFAULT_PAGE_SIZE = 25;
const DAY_GROUPING_MAX_DAYS = 370;
const ISTANBUL = 'Europe/Istanbul';

const BUCKET_PATTERN: Record<OfferAllowanceReportGroupBy, string> = {
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  year: 'YYYY',
};

type Filters = {
  fromInstant: Date | null;
  toInstant: Date | null;
  packageId: string | null;
  providerId: string | null;
  categoryId: string | null;
  now: Date;
};

export type CohortFigures = {
  grants: number;
  defined: number;
  usedTracked: number;
  usedLegacy: number;
  remainingUsable: number;
  remainingUsableViaOpenLeads: number;
  remainingUnusable: number;
  /**
   * SHOWCASE-ALLOWANCE-004 — the part of `remainingUnusable` a super admin
   * voided (the whole remainder of every VOID grant). Inside the sum, not
   * beside it: `defined = usedTracked + usedLegacy + remainingUsable +
   * remainingUnusable` still holds exactly.
   */
  remainingVoided: number;
};

export type UsageFigures = {
  usages: number;
  credits: number;
  valuedCredits: number;
  unvaluedCredits: number;
  /** Kuruş. Null when there are credits and none of them could be valued. */
  indicativeValueMinor: number | null;
};

export type UnplacedFigures = {
  pendingRights: number;
  pendingFreeOffers: number;
  expiredRights: number;
  expiredFreeOffers: number;
};

type Row = Record<string, unknown>;

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function toCohort(row: Row | undefined): CohortFigures {
  return {
    grants: num(row?.grants),
    defined: num(row?.defined),
    usedTracked: num(row?.usedTracked),
    usedLegacy: num(row?.usedLegacy),
    remainingUsable: num(row?.remainingUsable),
    remainingUsableViaOpenLeads: num(row?.remainingUsableViaOpenLeads),
    remainingUnusable: num(row?.remainingUnusable),
    remainingVoided: num(row?.remainingVoided),
  };
}

function toUsage(row: Row | undefined): UsageFigures {
  const credits = num(row?.credits);
  const valuedCredits = num(row?.valuedCredits);
  return {
    usages: num(row?.usages),
    credits,
    valuedCredits,
    unvaluedCredits: credits - valuedCredits,
    indicativeValueMinor: credits > 0 && valuedCredits === 0 ? null : num(row?.valueMinor),
  };
}

function toUnplaced(row: Row | undefined): UnplacedFigures {
  return {
    pendingRights: num(row?.pendingRights),
    pendingFreeOffers: num(row?.pendingFreeOffers),
    expiredRights: num(row?.expiredRights),
    expiredFreeOffers: num(row?.expiredFreeOffers),
  };
}

@Injectable()
export class OfferAllowanceReportService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async report(query: OfferAllowanceReportDto) {
    const groupBy = query.groupBy ?? 'month';
    if (query.from !== undefined && !isValidIsoDate(query.from)) {
      throw new BadRequestException('"from" must be a valid YYYY-MM-DD date');
    }
    if (query.to !== undefined && !isValidIsoDate(query.to)) {
      throw new BadRequestException('"to" must be a valid YYYY-MM-DD date');
    }
    const fromInstant = query.from ? parseIstanbulDayStart(query.from) : null;
    const toInstant = query.to ? parseIstanbulDayEnd(query.to) : null;
    if (fromInstant && toInstant && fromInstant > toInstant) {
      throw new BadRequestException('"from" must be on or before "to"');
    }
    if (groupBy === 'day') {
      // A day per row is only readable over a bounded window.
      // Counted in civil days, start of day to start of day, as the screen counts them.
      const end = query.to ? parseIstanbulDayStart(query.to) : new Date();
      if (!fromInstant || (end.getTime() - fromInstant.getTime()) / 86_400_000 > DAY_GROUPING_MAX_DAYS) {
        throw new BadRequestException(`groupBy=day needs "from" and a window of at most ${DAY_GROUPING_MAX_DAYS} days`);
      }
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const filters: Filters = {
      fromInstant,
      toInstant,
      packageId: query.packageId ?? null,
      providerId: query.providerId ?? null,
      categoryId: query.categoryId ?? null,
      now: new Date(),
    };
    const withUnplaced = filters.categoryId === null;
    const base = baseCtes(filters, groupBy);

    const result = await this.prisma.$transaction(
      async (tx) => {
        const read = (body: Prisma.Sql) => tx.$queryRaw<Row[]>(Prisma.sql`${base} ${body}`);

        const [cohortRow] = await read(Prisma.sql`SELECT ${COHORT_SUMS} FROM grant_rows`);
        const [usageRow] = await read(Prisma.sql`SELECT ${USAGE_SUMS} FROM usage_valued`);
        const [unplacedRow] = withUnplaced ? await read(Prisma.sql`SELECT ${UNPLACED_SUMS} FROM unplaced_rows`) : [];
        const [integrityRow] = await read(Prisma.sql`
          SELECT count(*) FILTER (WHERE "freeOfferCount" = 0)::int AS "zeroAllowancePlacements",
                 count(*) FILTER (WHERE "freeOfferCount" > 0 AND NOT "hasGrant")::int AS "placementsWithoutGrant"
            FROM placement_rows`);
        const [voidRow] = await read(Prisma.sql`SELECT count(*) FILTER (WHERE "status" = 'VOID')::int AS "voidGrants" FROM grant_rows`);

        const months = await read(Prisma.sql`
          SELECT uv."month",
                 count(*)::int AS "usages",
                 coalesce(sum(uv."credits"), 0)::int AS "credits",
                 r."purchases", r."paid", r."soldCredits"
            FROM usage_valued uv
            LEFT JOIN rates r ON r."month" = uv."month"
           GROUP BY uv."month", r."purchases", r."paid", r."soldCredits"
           ORDER BY uv."month"`);

        const [listRow] = await tx.$queryRaw<Row[]>(Prisma.sql`
          SELECT count(*)::int AS "packages",
                 min("priceAmount"::numeric / "creditAmount") AS "minPerCredit",
                 max("priceAmount"::numeric / "creditAmount") AS "maxPerCredit"
            FROM "OfferCreditPackage"
           WHERE "isActive" = true
             AND "type" = 'ONE_TIME_CREDITS'
             AND "creditAmount" > 0
             AND "currency" = 'TRY'`);

        const byPackage = await read(dimensionSql('packageId', withUnplaced));
        const byCategory = await read(dimensionSql('categoryId', false));
        const [providerCount] = await read(Prisma.sql`
          SELECT count(*)::int AS "total"
            FROM (SELECT "providerId" FROM grant_rows UNION SELECT "providerId" FROM usage_valued) k`);
        const byProvider = await read(
          Prisma.sql`${dimensionSql('providerId', false)} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        );
        const cohortByPeriod = await read(Prisma.sql`
          SELECT "bucket", ${COHORT_SUMS} FROM grant_rows GROUP BY "bucket" ORDER BY "bucket"`);
        const usageByPeriod = await read(Prisma.sql`
          SELECT "bucket", ${USAGE_SUMS} FROM usage_valued GROUP BY "bucket" ORDER BY "bucket"`);

        return {
          cohortRow,
          usageRow,
          unplacedRow,
          integrityRow,
          voidRow,
          months,
          listRow,
          byPackage,
          byCategory,
          providerTotal: num(providerCount?.total),
          byProvider,
          cohortByPeriod,
          usageByPeriod,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const usage = toUsage(result.usageRow);
    const minPerCredit = result.listRow?.minPerCredit;
    const maxPerCredit = result.listRow?.maxPerCredit;
    const listPackages = num(result.listRow?.packages);

    return {
      range: {
        from: query.from ?? null,
        to: query.to ?? null,
        groupBy,
        timezone: ISTANBUL,
      },
      filters: {
        packageId: filters.packageId,
        providerId: filters.providerId,
        categoryId: filters.categoryId,
      },
      /** Which clock each section's window and buckets read. */
      timeBases: {
        cohort: 'GRANT_VALID_FROM',
        usage: 'USAGE_CONSUMED_AT',
        unplaced: 'ENTITLEMENT_GRANTED_AT',
        valuation: 'USAGE_MONTH_PAID_CREDIT_PACKAGES',
      },
      cohort: toCohort(result.cohortRow),
      usage,
      unplaced: withUnplaced ? toUnplaced(result.unplacedRow) : null,
      valuation: {
        method: 'MONTHLY_WEIGHTED_PAID_CREDIT_PACKAGES',
        months: result.months.map((row) => {
          const soldCredits = row.soldCredits === null ? null : num(row.soldCredits);
          const paid = row.paid === null ? null : num(row.paid);
          return {
            month: String(row.month),
            usages: num(row.usages),
            credits: num(row.credits),
            purchases: row.purchases === null ? 0 : num(row.purchases),
            paidAmountMinor: paid,
            soldCredits,
            /** Kuruş per credit, two decimals; null when the month had no paid credit package. */
            perCreditMinor: paid !== null && soldCredits ? Math.round((paid / soldCredits) * 100) / 100 : null,
          };
        }),
        listPriceReference:
          listPackages > 0
            ? {
                basis: 'CURRENT_ACTIVE_CREDIT_PACKAGES',
                packages: listPackages,
                minPerCreditMinor: Math.round(num(minPerCredit) * 100) / 100,
                maxPerCreditMinor: Math.round(num(maxPerCredit) * 100) / 100,
                lowValueMinor: Math.round(usage.credits * num(minPerCredit)),
                highValueMinor: Math.round(usage.credits * num(maxPerCredit)),
              }
            : null,
      },
      integrity: {
        zeroAllowancePlacements: num(result.integrityRow?.zeroAllowancePlacements),
        placementsWithoutGrant: num(result.integrityRow?.placementsWithoutGrant),
        voidGrants: num(result.voidRow?.voidGrants),
      },
      byPackage: result.byPackage.map((row) => ({
        package: { id: String(row.key), name: row.name === null ? null : String(row.name) },
        cohort: toCohort(row),
        usage: toUsage(row),
        ...(withUnplaced ? { unplaced: toUnplaced(row) } : {}),
      })),
      byCategory: result.byCategory.map((row) => ({
        category: { id: String(row.key), name: row.name === null ? null : String(row.name) },
        cohort: toCohort(row),
        usage: toUsage(row),
      })),
      byProvider: {
        items: result.byProvider.map((row) => ({
          provider: { id: String(row.key), businessName: row.name === null ? null : String(row.name) },
          cohort: toCohort(row),
          usage: toUsage(row),
        })),
        total: result.providerTotal,
        page,
        pageSize,
        hasNextPage: page * pageSize < result.providerTotal,
      },
      cohortByPeriod: result.cohortByPeriod.map((row) => ({ bucket: String(row.bucket), ...toCohort(row) })),
      usageByPeriod: result.usageByPeriod.map((row) => ({ bucket: String(row.bucket), ...toUsage(row) })),
    };
  }
}

const COHORT_SUMS = Prisma.sql`
  count(*)::int AS "grants",
  coalesce(sum("quotaTotal"), 0)::int AS "defined",
  coalesce(sum("tracked"), 0)::int AS "usedTracked",
  coalesce(sum("legacy"), 0)::int AS "usedLegacy",
  coalesce(sum("usable"), 0)::int AS "remainingUsable",
  coalesce(sum("usableViaOpenLeads"), 0)::int AS "remainingUsableViaOpenLeads",
  coalesce(sum("remaining" - "usable"), 0)::int AS "remainingUnusable",
  coalesce(sum("remaining") FILTER (WHERE "status" = 'VOID'), 0)::int AS "remainingVoided"`;

const USAGE_SUMS = Prisma.sql`
  count(*)::int AS "usages",
  coalesce(sum("credits"), 0)::int AS "credits",
  coalesce(sum("credits") FILTER (WHERE "valueMinor" IS NOT NULL), 0)::int AS "valuedCredits",
  coalesce(sum("valueMinor"), 0)::bigint AS "valueMinor"`;

const UNPLACED_SUMS = Prisma.sql`
  count(*) FILTER (WHERE "pending")::int AS "pendingRights",
  coalesce(sum("freeOffers") FILTER (WHERE "pending"), 0)::int AS "pendingFreeOffers",
  count(*) FILTER (WHERE NOT "pending")::int AS "expiredRights",
  coalesce(sum("freeOffers") FILTER (WHERE NOT "pending"), 0)::int AS "expiredFreeOffers"`;

/** An Istanbul-local rendering of a stored (UTC, timezone-less) timestamp. */
function istanbulText(column: Prisma.Sql, pattern: string): Prisma.Sql {
  return Prisma.sql`to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${ISTANBUL}, ${pattern})`;
}

/**
 * A JS instant as the timezone-less UTC timestamp Prisma stores, whatever the
 * database session's own time zone is.
 */
function utcTimestamp(value: Date): Prisma.Sql {
  return Prisma.sql`(${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

function windowOn(column: Prisma.Sql, filters: Filters): Prisma.Sql {
  const from = filters.fromInstant ? Prisma.sql` AND ${column} >= ${utcTimestamp(filters.fromInstant)}` : Prisma.empty;
  const to = filters.toInstant ? Prisma.sql` AND ${column} <= ${utcTimestamp(filters.toInstant)}` : Prisma.empty;
  return Prisma.sql`${from}${to}`;
}

function equals(column: Prisma.Sql, value: string | null): Prisma.Sql {
  return value === null ? Prisma.empty : Prisma.sql` AND ${column} = ${value}`;
}

/**
 * The shared CTEs. Every report query is `base + SELECT …` over the same
 * definitions, so a breakdown can never filter differently from its total.
 */
function baseCtes(filters: Filters, groupBy: OfferAllowanceReportGroupBy): Prisma.Sql {
  const bucket = BUCKET_PATTERN[groupBy];
  return Prisma.sql`
WITH rates AS (
  SELECT ${istanbulText(Prisma.sql`pp."paidAt"`, 'YYYY-MM')} AS "month",
         count(*)::int AS "purchases",
         sum(pp."priceAmountSnapshot")::bigint AS "paid",
         sum(pp."creditAmountSnapshot")::bigint AS "soldCredits"
    FROM "PackagePurchase" pp
   WHERE pp."kind" = 'OFFER_PACKAGE'
     AND pp."status" = 'PAID'
     AND pp."paidAt" IS NOT NULL
     AND pp."creditAmountSnapshot" > 0
     AND pp."currencySnapshot" = 'TRY'
   GROUP BY 1
),
grant_base AS (
  SELECT g."id",
         g."providerId",
         p."showcasePackageId" AS "packageId",
         p."categoryId",
         g."quotaTotal",
         g."quotaUsed",
         g."status",
         ${istanbulText(Prisma.sql`g."validFrom"`, bucket)} AS "bucket",
         (SELECT count(*)::int FROM "OfferAllowanceUsage" u WHERE u."grantId" = g."id") AS "tracked",
         (g."status" = 'ACTIVE'
           AND ((p."status" IN ('PENDING_ACTIVATION', 'ACTIVE') AND p."endAt" > ${utcTimestamp(filters.now)})
                OR p."status" = 'SUSPENDED')) AS "live",
         (SELECT count(*)::int
            FROM "ShowcaseLead" l
            JOIN "ServiceRequest" r ON r."showcaseLeadId" = l."id"
            JOIN "ServiceRequestMatchRound" mr ON mr."id" = r."currentRoundId"
           WHERE l."placementId" = p."id"
             AND l."providerId" = g."providerId"
             AND l."status" IN ('OPEN', 'BREACHED')
             AND r."directShowcaseProviderId" = l."providerId"
             AND r."status" IN ('SUBMITTED', 'APPROVED')
             AND mr."source" = 'DIRECT_SHOWCASE') AS "openLeads"
    FROM "OfferAllowanceGrant" g
    JOIN "ShowcasePlacement" p ON p."id" = g."showcasePlacementId"
   WHERE g."source" = 'SHOWCASE_PLACEMENT'
     ${windowOn(Prisma.sql`g."validFrom"`, filters)}
     ${equals(Prisma.sql`p."showcasePackageId"`, filters.packageId)}
     ${equals(Prisma.sql`g."providerId"`, filters.providerId)}
     ${equals(Prisma.sql`p."categoryId"`, filters.categoryId)}
),
grant_rows AS (
  SELECT gb.*,
         gb."quotaUsed" - gb."tracked" AS "legacy",
         gb."quotaTotal" - gb."quotaUsed" AS "remaining",
         CASE
           WHEN gb."status" <> 'ACTIVE' THEN 0
           WHEN gb."live" THEN gb."quotaTotal" - gb."quotaUsed"
           ELSE LEAST(gb."quotaTotal" - gb."quotaUsed", gb."openLeads")
         END AS "usable",
         CASE
           WHEN gb."status" = 'ACTIVE' AND NOT gb."live" THEN LEAST(gb."quotaTotal" - gb."quotaUsed", gb."openLeads")
           ELSE 0
         END AS "usableViaOpenLeads"
    FROM grant_base gb
),
usage_rows AS (
  SELECT u."id",
         u."providerId",
         u."categoryId",
         p."showcasePackageId" AS "packageId",
         u."listCreditCostSnapshot" AS "credits",
         ${istanbulText(Prisma.sql`u."consumedAt"`, 'YYYY-MM')} AS "month",
         ${istanbulText(Prisma.sql`u."consumedAt"`, bucket)} AS "bucket"
    FROM "OfferAllowanceUsage" u
    JOIN "OfferAllowanceGrant" g ON g."id" = u."grantId"
    JOIN "ShowcasePlacement" p ON p."id" = g."showcasePlacementId"
   WHERE true
     ${windowOn(Prisma.sql`u."consumedAt"`, filters)}
     ${equals(Prisma.sql`p."showcasePackageId"`, filters.packageId)}
     ${equals(Prisma.sql`u."providerId"`, filters.providerId)}
     ${equals(Prisma.sql`u."categoryId"`, filters.categoryId)}
),
usage_valued AS (
  SELECT ur.*,
         CASE WHEN r."month" IS NULL THEN NULL
              ELSE round(ur."credits"::numeric * r."paid" / r."soldCredits")::bigint
         END AS "valueMinor"
    FROM usage_rows ur
    LEFT JOIN rates r ON r."month" = ur."month"
),
unplaced_rows AS (
  SELECT e."id",
         e."providerId",
         e."showcasePackageId" AS "packageId",
         e."freeOfferCountSnapshot" AS "freeOffers",
         (e."status" IN ('AVAILABLE', 'RESERVED')) AS "pending"
    FROM "ShowcaseEntitlement" e
    JOIN "PackagePurchase" pp ON pp."id" = e."purchaseId"
   WHERE e."placementId" IS NULL
     AND e."status" IN ('AVAILABLE', 'RESERVED', 'EXPIRED')
     AND pp."status" = 'PAID'
     ${windowOn(Prisma.sql`e."grantedAt"`, filters)}
     ${equals(Prisma.sql`e."showcasePackageId"`, filters.packageId)}
     ${equals(Prisma.sql`e."providerId"`, filters.providerId)}
),
placement_rows AS (
  SELECT p."id",
         p."freeOfferCountSnapshot" AS "freeOfferCount",
         EXISTS (SELECT 1 FROM "OfferAllowanceGrant" g WHERE g."showcasePlacementId" = p."id") AS "hasGrant"
    FROM "ShowcasePlacement" p
   WHERE true
     ${windowOn(Prisma.sql`p."startAt"`, filters)}
     ${equals(Prisma.sql`p."showcasePackageId"`, filters.packageId)}
     ${equals(Prisma.sql`p."providerId"`, filters.providerId)}
     ${equals(Prisma.sql`p."categoryId"`, filters.categoryId)}
)`;
}

const DIMENSION_NAME: Record<'packageId' | 'categoryId' | 'providerId', Prisma.Sql> = {
  packageId: Prisma.sql`(SELECT sp."name" FROM "ShowcasePackage" sp WHERE sp."id" = k."key")`,
  categoryId: Prisma.sql`(SELECT sc."name" FROM "ServiceCategory" sc WHERE sc."id" = k."key")`,
  providerId: Prisma.sql`(SELECT pr."businessName" FROM "ProviderProfile" pr WHERE pr."id" = k."key")`,
};

/**
 * One row per key that appears in the cohort, the usage (or, for packages, the
 * unplaced rights), with each section's figures side by side and still on its
 * own clock. Ordered by used credits, then defined slots, then name and id —
 * a total order, so a page boundary is stable.
 */
function dimensionSql(key: 'packageId' | 'categoryId' | 'providerId', withUnplaced: boolean): Prisma.Sql {
  const column = Prisma.raw(`"${key}"`);
  const unplacedKeys = withUnplaced ? Prisma.sql`UNION SELECT ${column} FROM unplaced_rows` : Prisma.empty;
  const unplacedJoin = withUnplaced
    ? Prisma.sql`LEFT JOIN (SELECT ${column} AS "key", ${UNPLACED_SUMS} FROM unplaced_rows GROUP BY ${column}) up ON up."key" = k."key"`
    : Prisma.empty;
  const unplacedColumns = withUnplaced
    ? Prisma.sql`, up."pendingRights", up."pendingFreeOffers", up."expiredRights", up."expiredFreeOffers"`
    : Prisma.empty;

  return Prisma.sql`
SELECT k."key",
       ${DIMENSION_NAME[key]} AS "name",
       coalesce(c."grants", 0) AS "grants", c."defined", c."usedTracked", c."usedLegacy",
       c."remainingUsable", c."remainingUsableViaOpenLeads", c."remainingUnusable", c."remainingVoided",
       coalesce(us."usages", 0) AS "usages", us."credits", us."valuedCredits", us."valueMinor"
       ${unplacedColumns}
  FROM (SELECT ${column} AS "key" FROM grant_rows UNION SELECT ${column} FROM usage_valued ${unplacedKeys}) k
  LEFT JOIN (SELECT ${column} AS "key", ${COHORT_SUMS} FROM grant_rows GROUP BY ${column}) c ON c."key" = k."key"
  LEFT JOIN (SELECT ${column} AS "key", ${USAGE_SUMS} FROM usage_valued GROUP BY ${column}) us ON us."key" = k."key"
  ${unplacedJoin}
 ORDER BY coalesce(us."credits", 0) DESC, coalesce(c."defined", 0) DESC, ${DIMENSION_NAME[key]} ASC NULLS LAST, k."key" ASC`;
}
