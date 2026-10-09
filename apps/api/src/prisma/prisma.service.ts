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

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ omit: SEARCH_PROJECTION_OMIT });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
