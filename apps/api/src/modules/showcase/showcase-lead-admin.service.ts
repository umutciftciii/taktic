import { Inject, Injectable } from '@nestjs/common';
import { Prisma, ShowcaseLeadStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListShowcaseLeadsDto, showcaseAdminPage } from './dto/admin-showcase-list.dto';
import { showcaseLeadNotFound } from './showcase.errors';

/**
 * Direct leads, for the operator.
 *
 * Read-only, and that is the whole surface. An operator's power over a lead is
 * exercised through the request it belongs to — refusing the request closes the
 * lead in the same transaction — rather than through an endpoint that could
 * close a lead while leaving the request open, or release one on a customer's
 * behalf.
 *
 * That second omission is deliberate and load-bearing. Releasing a lead to the
 * market is the customer's decision and only theirs; the database refuses a
 * `releasedAt` without their RELEASE on the same row, and an admin route that
 * bypassed that would make the constraint decorative.
 *
 * ## What the projection carries
 *
 * The customer's own contact details are **not** selected, exactly as they are
 * not on the provider's inbox. The reveal path is `ContactRevealEvent`, and an
 * operator reading a queue has no more need of a telephone number than a
 * provider does.
 */
@Injectable()
export class ShowcaseLeadAdminService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * One page of leads, newest first, with the total for the filter and the
   * per-status counts for the scope (API-HARDENING-001).
   *
   * Used to stop at the newest 200 with no total, so an older lead was
   * unreachable from the operator's screen. Now every row is reachable by
   * page, and the counts are exact: `total` is the filtered list's size and
   * `statusCounts` answers the saved-view tabs without the status filter (the
   * provider filter still applies — it is the scope, not a view).
   *
   * All three reads run in one REPEATABLE READ transaction, so the page, its
   * total and the tab counts describe the same moment rather than three.
   */
  async list(filters: ListShowcaseLeadsDto) {
    const { page, pageSize, skip } = showcaseAdminPage(filters);
    const scope: Prisma.ShowcaseLeadWhereInput = filters.providerId ? { providerId: filters.providerId } : {};
    const where: Prisma.ShowcaseLeadWhereInput = {
      ...scope,
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [total, leads, grouped] = await this.prisma.$transaction(
      [
        this.prisma.showcaseLead.count({ where }),
        this.prisma.showcaseLead.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: pageSize,
          select: adminLeadSelect,
        }),
        this.prisma.showcaseLead.groupBy({
          by: ['status'],
          where: scope,
          orderBy: { status: 'asc' },
          _count: { _all: true },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const statusCounts = Object.fromEntries(
      Object.values(ShowcaseLeadStatus).map((status) => [status, 0]),
    ) as Record<ShowcaseLeadStatus, number>;
    for (const row of grouped) {
      const count = row._count;
      statusCounts[row.status] = typeof count === 'object' ? (count._all ?? 0) : 0;
    }

    return {
      leads,
      total,
      page,
      pageSize,
      hasNextPage: skip + leads.length < total,
      statusCounts,
    };
  }

  async get(leadId: string) {
    const lead = await this.prisma.showcaseLead.findUnique({
      where: { id: leadId },
      select: {
        ...adminLeadSelect,
        placement: {
          select: { id: true, status: true, startAt: true, endAt: true, packageNameSnapshot: true },
        },
      },
    });

    if (!lead) {
      throw showcaseLeadNotFound();
    }

    return lead;
  }
}

const adminLeadSelect = {
  id: true,
  status: true,
  urgencyBucket: true,
  slaHoursSnapshot: true,
  slaDueAt: true,
  breachedAt: true,
  fallbackAskedAt: true,
  fallbackDecision: true,
  fallbackDecidedAt: true,
  releasedAt: true,
  closedAt: true,
  closeReason: true,
  respondedAt: true,
  createdAt: true,
  kindSnapshot: true,
  listedPriceSnapshot: true,
  cardId: true,
  cardVersion: { select: { id: true, versionNumber: true, title: true } },
  provider: { select: { id: true, businessName: true, status: true } },
  request: {
    select: {
      id: true,
      requestNumber: true,
      status: true,
      qualityScore: true,
      city: true,
      district: true,
      directShowcaseProviderId: true,
      category: { select: { id: true, name: true, slug: true } },
      submittedAt: true,
    },
  },
} satisfies Prisma.ShowcaseLeadSelect;
