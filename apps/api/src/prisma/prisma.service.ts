import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * ADMIN-SEARCH-TURKISH-HARDENING-001: the `*Search` columns are PostgreSQL's
 * folded copy of a text column (`taktic_search_fold`), there for the admin
 * search box to filter on and for nothing else. Left out of every read by
 * default, so a model returned without an explicit `select` keeps the exact
 * key set it had before the columns existed. A query that filters on one
 * (`where: { nameSearch: { contains } }`) is unaffected: omit shapes results,
 * not conditions.
 */
export const SEARCH_PROJECTION_OMIT = {
  user: { nameSearch: true },
  providerProfile: { businessNameSearch: true, contactNameSearch: true },
  serviceRequest: { customerNameSearch: true, citySearch: true, districtSearch: true },
  providerCreditTransaction: { reasonSearch: true },
} as const satisfies Prisma.GlobalOmitConfig;

/**
 * REL-002: the match-round link columns. Since Faz 2 the matching core reads
 * them on every decision — always through an explicit `select` (or a local
 * `omit: { roundId: false }`), which this default does not affect. They stay
 * out of every *default* read for the same reason as the search columns: a
 * model returned without an explicit `select` keeps the key set it had before
 * the columns existed, so no API response carries round ids until a product
 * surface decides to show them (Faz 3).
 *
 * Note the types do not see this omit: a default read is typed as carrying
 * the column but returns `undefined` for it. Read round ids explicitly.
 */
export const MATCH_ROUND_PROJECTION_OMIT = {
  serviceRequest: { currentRoundId: true },
  offer: { matchRoundId: true },
  contactRevealEvent: { roundId: true },
  messageThread: { roundId: true },
} as const satisfies Prisma.GlobalOmitConfig;

/** Everything PrismaService leaves out of a default read. */
export const DEFAULT_PROJECTION_OMIT = {
  ...SEARCH_PROJECTION_OMIT,
  ...MATCH_ROUND_PROJECTION_OMIT,
  serviceRequest: {
    ...SEARCH_PROJECTION_OMIT.serviceRequest,
    ...MATCH_ROUND_PROJECTION_OMIT.serviceRequest,
  },
} as const satisfies Prisma.GlobalOmitConfig;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ omit: DEFAULT_PROJECTION_OMIT });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
