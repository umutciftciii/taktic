import { CustomerOrigin, OfferStatus, Prisma, UserRole } from '@prisma/client';
import type { AdminTextSearch } from '../../common/admin-search';
import type { CustomerSortDirection, CustomerSortField } from './dto/list-customers.dto';

/**
 * ADMIN-SEARCH-PAGINATION-001: the customer list's filter and order as one
 * SQL statement, so the database counts the match and returns one page of it.
 *
 * The list used to read every matching customer, the request and offer
 * figures of all of them, sort the lot in the process and slice a page off
 * the end. The figures it sorts by (the last request, the request, offer and
 * accepted-offer counts) are aggregates over other tables that Prisma's
 * `orderBy` cannot express, and the name sort is Turkish (`localeCompare(…,
 * 'tr')`), which the database's default collation is not. Both are written
 * here instead, and the count and the page read the same WHERE.
 *
 * The WHERE is the one the list's Prisma filter generated, restated clause by
 * clause — `contains … insensitive` is `ILIKE '%' || box || '%'` (Prisma does
 * not escape `%` or `_` either), `contains` on a `*Search` column is `LIKE`,
 * `equals … insensitive` is a bare `ILIKE`, and `serviceRequests: { some }` is
 * an `EXISTS` — so the rows it selects are the rows it always selected. The
 * order is the comparator the list sorted with: the chosen key in the chosen
 * direction, then the id ascending in either direction.
 */

export type CustomerListFilter = {
  search: AdminTextSearch | null;
  customerOrigin: CustomerOrigin | undefined;
  city: string | undefined;
  lastRequestRange: { gte?: Date; lte?: Date } | undefined;
};

/** A timestamp the way Prisma compares one with a `timestamp(3)` column: UTC. */
function utcTimestamp(value: Date): Prisma.Sql {
  return Prisma.sql`(${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

export function customerListWhere(filter: CustomerListFilter): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`u."role" = ${UserRole.CUSTOMER}::"UserRole"`];

  const { search } = filter;
  if (search) {
    const pattern = `%${search.text}%`;
    const arms: Prisma.Sql[] = [
      Prisma.sql`u."name" ILIKE ${pattern}`,
      Prisma.sql`u."nameSearch" LIKE ${`%${search.folded}%`}`,
      Prisma.sql`u."email" ILIKE ${pattern}`,
      // phoneColumnMatchers: the substring always, the exact spellings when the
      // box is a whole number.
      Prisma.sql`u."phone" ILIKE ${pattern}`,
      ...(search.phoneSpellings ? [Prisma.sql`u."phone" IN (${Prisma.join(search.phoneSpellings)})`] : []),
    ];
    clauses.push(Prisma.sql`(${Prisma.join(arms, ' OR ')})`);
  }

  if (filter.customerOrigin) {
    clauses.push(Prisma.sql`u."customerOrigin" = ${filter.customerOrigin}::"CustomerOrigin"`);
  }

  // city and the lastRequest* range look at the customer's requests: one
  // request has to satisfy all of them.
  const requestClauses: Prisma.Sql[] = [];
  if (filter.city) {
    requestClauses.push(Prisma.sql`sr."city" ILIKE ${filter.city}`);
  }
  if (filter.lastRequestRange?.gte) {
    requestClauses.push(Prisma.sql`sr."submittedAt" >= ${utcTimestamp(filter.lastRequestRange.gte)}`);
  }
  if (filter.lastRequestRange?.lte) {
    requestClauses.push(Prisma.sql`sr."submittedAt" <= ${utcTimestamp(filter.lastRequestRange.lte)}`);
  }
  if (requestClauses.length > 0) {
    clauses.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "ServiceRequest" sr WHERE sr."customerId" = u."id" AND ${Prisma.join(
        requestClauses,
        ' AND ',
      )})`,
    );
  }

  return Prisma.join(clauses, ' AND ');
}

const REQUEST_FIGURES = Prisma.sql`LEFT JOIN (
  SELECT "customerId", COUNT(*)::int AS "requestCount", MAX("submittedAt") AS "lastRequestAt"
  FROM "ServiceRequest"
  WHERE "customerId" IS NOT NULL
  GROUP BY "customerId"
) rs ON rs."customerId" = u."id"`;

const OFFER_FIGURES = Prisma.sql`LEFT JOIN (
  SELECT sr."customerId",
         COUNT(*)::int AS "offerCount",
         (COUNT(*) FILTER (WHERE o."status" = ${OfferStatus.ACCEPTED}::"OfferStatus"))::int AS "acceptedOfferCount"
  FROM "Offer" o
  JOIN "ServiceRequest" sr ON sr."id" = o."requestId"
  WHERE sr."customerId" IS NOT NULL
  GROUP BY sr."customerId"
) os ON os."customerId" = u."id"`;

/** The figures a sort needs joined in, and the sort itself. */
function customerOrder(sortBy: CustomerSortField, sortDir: CustomerSortDirection) {
  const dir = Prisma.raw(sortDir === 'asc' ? 'ASC' : 'DESC');
  switch (sortBy) {
    case 'name':
      // `(a.name ?? '').localeCompare(b.name ?? '', 'tr')`.
      return { join: Prisma.empty, key: Prisma.sql`COALESCE(u."name", '') COLLATE "tr-x-icu" ${dir}` };
    case 'createdAt':
      return { join: Prisma.empty, key: Prisma.sql`u."createdAt" ${dir}` };
    case 'lastRequestAt':
      // A customer without a request sorts below every date: first ascending,
      // last descending.
      return {
        join: REQUEST_FIGURES,
        key: Prisma.sql`rs."lastRequestAt" ${dir} ${Prisma.raw(sortDir === 'asc' ? 'NULLS FIRST' : 'NULLS LAST')}`,
      };
    case 'requestCount':
      return { join: REQUEST_FIGURES, key: Prisma.sql`COALESCE(rs."requestCount", 0) ${dir}` };
    case 'offerCount':
      return { join: OFFER_FIGURES, key: Prisma.sql`COALESCE(os."offerCount", 0) ${dir}` };
    case 'acceptedOfferCount':
      return { join: OFFER_FIGURES, key: Prisma.sql`COALESCE(os."acceptedOfferCount", 0) ${dir}` };
  }
}

/** How many customers match: the same WHERE as the page. */
export function customerCountSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`SELECT COUNT(*)::int AS "total" FROM "User" u WHERE ${where}`;
}

/**
 * One page of matching customer ids, in list order. The id is the tie-breaker
 * in both directions — ascending, compared byte-wise (`COLLATE "C"`), which is
 * how `localeCompare` orders the ids' lower-case letters and digits — so a
 * page boundary never falls between two rows that could swap.
 */
export function customerPageSql(
  where: Prisma.Sql,
  sortBy: CustomerSortField,
  sortDir: CustomerSortDirection,
  page: number,
  pageSize: number,
): Prisma.Sql {
  const order = customerOrder(sortBy, sortDir);
  return Prisma.sql`SELECT u."id" FROM "User" u ${order.join}
    WHERE ${where}
    ORDER BY ${order.key}, u."id" COLLATE "C" ASC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
}
