import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminPermission, CustomerOrigin, OfferStatus, Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { mayEmbed, staffActorSelect } from '../auth/embedded-permissions';
import { INSUFFICIENT_PERMISSION } from '../auth/permissions.guard';
import { AuditPageQueryDto } from '../../common/admin-audit';
import { readAccountStatusHistory } from '../../common/account-status-history';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCustomerNoteDto } from './dto/create-customer-note.dto';
import {
  CustomerSortDirection,
  CustomerSortField,
  ListCustomersDto,
} from './dto/list-customers.dto';
import { UpdateCustomerStatusDto } from './dto/update-customer-status.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const RECENT_REQUESTS_LIMIT = 10;
const RECENT_OFFERS_LIMIT = 10;
const ACCEPTED_OFFERS_LIMIT = 10;

type QualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';

function qualityLabel(score: number): QualityLabel {
  if (score >= 80) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

type CustomerListItem = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  customerOrigin: CustomerOrigin | null;
  /**
   * The account's own proofs — `User.emailVerifiedAt` / `User.phoneVerifiedAt`
   * and nothing else. A request of theirs verified by one-time code says
   * nothing here: that proof was for the request's number at the time, not
   * for the account's number now. NULL is "never proven", including every
   * account older than the columns.
   */
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  requestCount: number;
  offerCount: number;
  acceptedOfferCount: number;
  lastRequestAt: Date | null;
  lastRequestCity: string | null;
};

@Injectable()
export class CustomersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The operator's customer list (CUSTOMERS_READ).
   *
   * The account columns are this route's. The request figures (count, last
   * request, its city, and the unlinked-request notice) are REQUESTS_READ's
   * and the offer figures OFFERS_READ's: absent from every row for a caller
   * without that permission, and not computed at all. Sorting or filtering by
   * one of them would answer the same question through the order of the rows,
   * so those parameters are refused (403) instead of ignored; the default sort
   * falls back to the account's own creation date.
   */
  async list(filters: ListCustomersDto, viewer: AuthUser | null = null) {
    const scope = customerEmbedScope(viewer);
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);
    const sortBy: CustomerSortField =
      filters.sortBy ?? (scope.requests ? 'lastRequestAt' : 'createdAt');
    const sortDir: CustomerSortDirection = filters.sortDir ?? 'desc';

    const needsRequests =
      REQUEST_SORT_FIELDS.has(sortBy) ||
      Boolean(filters.city || filters.lastRequestFrom || filters.lastRequestTo);
    const needsOffers = OFFER_SORT_FIELDS.has(sortBy);
    if ((needsRequests && !scope.requests) || (needsOffers && !scope.offers)) {
      throw new ForbiddenException({
        code: INSUFFICIENT_PERMISSION,
        message: 'Insufficient permission',
      });
    }

    const lastRequestRange = parseDateRange(
      filters.lastRequestFrom,
      filters.lastRequestTo,
      'lastRequestFrom',
      'lastRequestTo',
    );

    const userWhere: Prisma.UserWhereInput = {
      role: UserRole.CUSTOMER,
    };

    if (filters.q) {
      const term = filters.q;
      userWhere.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }

    if (filters.customerOrigin) {
      userWhere.customerOrigin = filters.customerOrigin as CustomerOrigin;
    }

    // city ve lastRequest* filtreleri müşterinin taleplerine bakar.
    const serviceRequestFilters: Prisma.ServiceRequestWhereInput[] = [];
    if (filters.city) {
      serviceRequestFilters.push({ city: { equals: filters.city, mode: 'insensitive' } });
    }
    if (lastRequestRange) {
      serviceRequestFilters.push({ submittedAt: lastRequestRange });
    }
    if (serviceRequestFilters.length > 0) {
      userWhere.serviceRequests = {
        some:
          serviceRequestFilters.length === 1
            ? serviceRequestFilters[0]
            : { AND: serviceRequestFilters },
      };
    }

    const customers = await this.prisma.user.findMany({
      where: userWhere,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        customerOrigin: true,
        // Two more columns on the same row — no lookup per customer.
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
      },
    });

    const total = customers.length;
    const customerIds = customers.map((customer) => customer.id);

    const [requestStats, offerStats, lastRequests, anonymousRequestCount] = await Promise.all([
      customerIds.length === 0 || !scope.requests
        ? Promise.resolve(
            [] as Array<{
              customerId: string | null;
              _count: { _all: number };
              _max: { submittedAt: Date | null };
            }>,
          )
        : this.prisma.serviceRequest.groupBy({
            by: ['customerId'],
            where: { customerId: { in: customerIds } },
            _count: { _all: true },
            _max: { submittedAt: true },
          }),
      customerIds.length === 0 || !scope.offers
        ? Promise.resolve([] as Array<{ customerId: string; status: OfferStatus; count: number }>)
        : this.prisma.$queryRaw<
            Array<{ customerId: string; status: OfferStatus; count: bigint }>
          >(Prisma.sql`
            SELECT sr."customerId" AS "customerId", o."status" AS "status", COUNT(*)::bigint AS "count"
            FROM "Offer" o
            JOIN "ServiceRequest" sr ON sr."id" = o."requestId"
            WHERE sr."customerId" IN (${Prisma.join(customerIds)})
            GROUP BY sr."customerId", o."status"
          `).then((rows) =>
            rows.map((row) => ({
              customerId: row.customerId,
              status: row.status,
              count: Number(row.count),
            })),
          ),
      customerIds.length === 0 || !scope.requests
        ? Promise.resolve([] as Array<{ customerId: string; city: string; submittedAt: Date }>)
        : this.prisma.$queryRaw<
            Array<{ customerId: string; city: string; submittedAt: Date }>
          >(Prisma.sql`
            SELECT DISTINCT ON ("customerId") "customerId", "city", "submittedAt"
            FROM "ServiceRequest"
            WHERE "customerId" IN (${Prisma.join(customerIds)})
            ORDER BY "customerId", "submittedAt" DESC, "id" DESC
          `),
      scope.requests
        ? this.prisma.serviceRequest.count({ where: { customerId: null } })
        : Promise.resolve(null),
    ]);

    const requestStatsByCustomer = new Map<
      string,
      { count: number; lastSubmittedAt: Date | null }
    >();
    for (const row of requestStats) {
      if (!row.customerId) continue;
      requestStatsByCustomer.set(row.customerId, {
        count: row._count._all,
        lastSubmittedAt: row._max.submittedAt ?? null,
      });
    }

    const offerStatsByCustomer = new Map<string, { total: number; accepted: number }>();
    for (const row of offerStats) {
      const current = offerStatsByCustomer.get(row.customerId) ?? { total: 0, accepted: 0 };
      current.total += row.count;
      if (row.status === OfferStatus.ACCEPTED) {
        current.accepted += row.count;
      }
      offerStatsByCustomer.set(row.customerId, current);
    }

    const lastRequestByCustomer = new Map<string, { city: string; submittedAt: Date }>();
    for (const row of lastRequests) {
      lastRequestByCustomer.set(row.customerId, {
        city: row.city,
        submittedAt: row.submittedAt,
      });
    }

    const items: CustomerListItem[] = customers.map((customer) => {
      const requestStat = requestStatsByCustomer.get(customer.id);
      const offerStat = offerStatsByCustomer.get(customer.id);
      const lastRequest = lastRequestByCustomer.get(customer.id);
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        isActive: customer.isActive,
        createdAt: customer.createdAt,
        lastLoginAt: customer.lastLoginAt,
        customerOrigin: customer.customerOrigin,
        emailVerifiedAt: customer.emailVerifiedAt,
        phoneVerifiedAt: customer.phoneVerifiedAt,
        requestCount: requestStat?.count ?? 0,
        offerCount: offerStat?.total ?? 0,
        acceptedOfferCount: offerStat?.accepted ?? 0,
        lastRequestAt: requestStat?.lastSubmittedAt ?? lastRequest?.submittedAt ?? null,
        lastRequestCity: lastRequest?.city ?? null,
      };
    });

    // Aggregate alanlara göre sort gerektiğinden tüm listeyi belleğe alıp sort ediyoruz.
    // Müşteri sayısı büyürse SQL/raw aggregate'e geçilmeli (rapora bkz).
    items.sort(buildCustomerComparator(sortBy, sortDir));

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pagedItems = items.slice(start, end);
    const hasNextPage = end < total;

    return {
      items: pagedItems.map((item) => toCustomerListRow(item, scope)),
      total,
      page,
      pageSize,
      hasNextPage,
      meta: anonymousRequestCount !== null ? { anonymousRequestCount } : {},
    };
  }

  /**
   * The operator's customer page (CUSTOMERS_READ).
   *
   * The account is this route's. The customer's requests are REQUESTS_READ's
   * and the offers they received OFFERS_READ's; each block — rows and the
   * figures that count them — is read and carried only for a caller holding
   * that permission, and is absent from the body otherwise (see `mayEmbed`).
   */
  async detail(id: string, viewer: AuthUser | null = null) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        role: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        customerOrigin: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        passwordHash: true,
      },
    });

    if (!user || user.role !== UserRole.CUSTOMER) {
      throw new NotFoundException('Customer not found');
    }

    const hasPassword = user.passwordHash !== null;
    const scope = customerEmbedScope(viewer);

    const [requests, offers] = await Promise.all([
      scope.requests ? this.detailRequests(id) : Promise.resolve(null),
      scope.offers ? this.detailOffers(id) : Promise.resolve(null),
    ]);

    return {
      customer: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
        customerOrigin: user.customerOrigin,
        // The same two account columns the list carries; see CustomerListItem.
        emailVerifiedAt: user.emailVerifiedAt,
        phoneVerifiedAt: user.phoneVerifiedAt,
        hasPassword,
      },
      // Each figure travels with the block it summarises: a caller that may
      // not read the requests is not told how many there are either.
      metrics: {
        ...(requests ? requests.metrics : {}),
        ...(offers ? offers.metrics : {}),
      },
      ...(requests ? { recentRequests: requests.recentRequests } : {}),
      ...(offers ? { recentOffers: offers.recentOffers, acceptedOffers: offers.acceptedOffers } : {}),
    };
  }

  /** The customer's requests, for a caller holding REQUESTS_READ. */
  private async detailRequests(id: string) {
    const [requestCount, lastRequest, recentRequestRows] = await Promise.all([
      this.prisma.serviceRequest.count({ where: { customerId: id } }),
      this.prisma.serviceRequest.findFirst({
        where: { customerId: id },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        select: { submittedAt: true },
      }),
      this.prisma.serviceRequest.findMany({
        where: { customerId: id },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        take: RECENT_REQUESTS_LIMIT,
        select: {
          id: true,
          requestNumber: true,
          city: true,
          district: true,
          status: true,
          qualityScore: true,
          submittedAt: true,
          category: { select: { name: true } },
          _count: { select: { offers: true } },
        },
      }),
    ]);

    return {
      metrics: { requestCount, lastRequestAt: lastRequest?.submittedAt ?? null },
      recentRequests: recentRequestRows.map((row) => ({
        id: row.id,
        requestNumber: row.requestNumber,
        categoryName: row.category.name,
        city: row.city,
        district: row.district,
        status: row.status,
        qualityLabel: qualityLabel(row.qualityScore),
        submittedAt: row.submittedAt,
        offerCount: row._count.offers,
      })),
    };
  }

  /** The offers the customer received, for a caller holding OFFERS_READ. */
  private async detailOffers(id: string) {
    const offerSelect = {
      id: true,
      offerNumber: true,
      requestId: true,
      providerId: true,
      priceAmount: true,
      currency: true,
      status: true,
      submittedAt: true,
      request: { select: { requestNumber: true } },
      provider: { select: { businessName: true } },
    } satisfies Prisma.OfferSelect;

    const [offerCount, acceptedOfferCount, recentOfferRows, acceptedOfferRows] = await Promise.all([
      this.prisma.offer.count({ where: { request: { customerId: id } } }),
      this.prisma.offer.count({
        where: { request: { customerId: id }, status: OfferStatus.ACCEPTED },
      }),
      this.prisma.offer.findMany({
        where: { request: { customerId: id } },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        take: RECENT_OFFERS_LIMIT,
        select: offerSelect,
      }),
      this.prisma.offer.findMany({
        where: { request: { customerId: id }, status: OfferStatus.ACCEPTED },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
        take: ACCEPTED_OFFERS_LIMIT,
        select: offerSelect,
      }),
    ]);

    const mapOffer = (row: (typeof recentOfferRows)[number]) => ({
      id: row.id,
      offerNumber: row.offerNumber,
      requestId: row.requestId,
      requestNumber: row.request.requestNumber,
      providerId: row.providerId,
      providerName: row.provider.businessName,
      priceAmount: row.priceAmount,
      currency: row.currency,
      status: row.status,
      submittedAt: row.submittedAt,
    });

    return {
      metrics: { offerCount, acceptedOfferCount },
      recentOffers: recentOfferRows.map(mapOffer),
      acceptedOffers: acceptedOfferRows.map(mapOffer),
    };
  }

  /** Notes with their author; the author's e-mail per `mayEmbedStaffEmail` (ADMIN_USERS_READ). */
  async listNotes(customerId: string, viewer: AuthUser | null = null) {
    await this.assertCustomerExists(customerId);

    const notes = await this.prisma.customerNote.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        note: true,
        createdAt: true,
        updatedAt: true,
        createdBy: staffActorSelect(viewer),
      },
    });

    return { items: notes };
  }

  async createNote(customerId: string, dto: CreateCustomerNoteDto, actorId: string, viewer: AuthUser | null = null) {
    await this.assertCustomerExists(customerId);

    const note = await this.prisma.customerNote.create({
      data: {
        customerId,
        note: dto.note,
        createdById: actorId,
      },
      select: {
        id: true,
        note: true,
        createdAt: true,
        updatedAt: true,
        createdBy: staffActorSelect(viewer),
      },
    });

    return note;
  }

  async updateStatus(customerId: string, dto: UpdateCustomerStatusDto, actor: AuthUser) {
    await this.assertCustomerExists(customerId);

    // ADMIN-ACTION-AUDIT-001: the flip and its audit row commit together. The
    // write is conditional on the value being the other one, so its count is
    // the answer to "did this request change anything": a repeated save still
    // answers 200 with the current value, as it always has, and records no row.
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id: customerId, role: UserRole.CUSTOMER, isActive: !dto.isActive },
        data: { isActive: dto.isActive },
      });
      if (changed.count === 1) {
        await tx.accountStatusChange.create({
          data: {
            userId: customerId,
            userRole: UserRole.CUSTOMER,
            fromActive: !dto.isActive,
            toActive: dto.isActive,
            reason: null,
            actorId: actor.id,
          },
          select: { id: true },
        });
      }
      return tx.user.findUniqueOrThrow({ where: { id: customerId }, select: { id: true, isActive: true } });
    });
  }

  /** The customer's status history, newest first (ADMIN-ACTION-AUDIT-001). */
  async statusHistory(customerId: string, query: AuditPageQueryDto | undefined, viewer: AuthUser) {
    await this.assertCustomerExists(customerId);
    return readAccountStatusHistory(this.prisma, customerId, 'CUSTOMER', query, viewer);
  }

  private async assertCustomerExists(customerId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: { id: true, role: true },
    });

    if (!user || user.role !== UserRole.CUSTOMER) {
      throw new NotFoundException('Customer not found');
    }

    return user;
  }
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function parseDateRange(
  fromInput: string | undefined,
  toInput: string | undefined,
  fromKey: string,
  toKey: string,
): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {};
  if (fromInput) {
    const fromDate = new Date(fromInput);
    if (Number.isNaN(fromDate.getTime())) {
      throw new BadRequestException(`Invalid "${fromKey}" date`);
    }
    range.gte = fromDate;
  }
  if (toInput) {
    const toDate = new Date(toInput);
    if (Number.isNaN(toDate.getTime())) {
      throw new BadRequestException(`Invalid "${toKey}" date`);
    }
    range.lte = toDate;
  }
  if (range.gte === undefined && range.lte === undefined) return undefined;
  if (range.gte && range.lte && (range.gte as Date) > (range.lte as Date)) {
    throw new BadRequestException(`"${fromKey}" must be on or before "${toKey}"`);
  }
  return range;
}

/**
 * Which other domains an operator's customer response may carry
 * (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001).
 */
type CustomerEmbedScope = { requests: boolean; offers: boolean };

function customerEmbedScope(viewer: AuthUser | null): CustomerEmbedScope {
  return {
    requests: mayEmbed(viewer, AdminPermission.REQUESTS_READ),
    offers: mayEmbed(viewer, AdminPermission.OFFERS_READ),
  };
}

const REQUEST_SORT_FIELDS: ReadonlySet<CustomerSortField> = new Set(['lastRequestAt', 'requestCount']);
const OFFER_SORT_FIELDS: ReadonlySet<CustomerSortField> = new Set(['offerCount', 'acceptedOfferCount']);

/**
 * One row on the way out: the account columns always, each domain's figures
 * only for a caller that may read that domain. The internal item is sorted
 * first, and a sort on a figure the caller may not read never gets this far.
 */
function toCustomerListRow(item: CustomerListItem, scope: CustomerEmbedScope) {
  const {
    requestCount,
    lastRequestAt,
    lastRequestCity,
    offerCount,
    acceptedOfferCount,
    ...account
  } = item;
  return {
    ...account,
    ...(scope.requests ? { requestCount, lastRequestAt, lastRequestCity } : {}),
    ...(scope.offers ? { offerCount, acceptedOfferCount } : {}),
  };
}

function buildCustomerComparator(sortBy: CustomerSortField, sortDir: CustomerSortDirection) {
  const direction = sortDir === 'desc' ? -1 : 1;
  return (a: CustomerListItem, b: CustomerListItem): number => {
    const cmp = compareCustomers(a, b, sortBy);
    if (cmp !== 0) return cmp * direction;
    // Deterministik tiebreaker
    return a.id.localeCompare(b.id);
  };
}

function compareCustomers(
  a: CustomerListItem,
  b: CustomerListItem,
  sortBy: CustomerSortField,
): number {
  switch (sortBy) {
    case 'name':
      return (a.name ?? '').localeCompare(b.name ?? '', 'tr');
    case 'createdAt':
      return a.createdAt.getTime() - b.createdAt.getTime();
    case 'lastRequestAt':
      return compareNullableDates(a.lastRequestAt, b.lastRequestAt);
    case 'requestCount':
      return a.requestCount - b.requestCount;
    case 'offerCount':
      return a.offerCount - b.offerCount;
    case 'acceptedOfferCount':
      return a.acceptedOfferCount - b.acceptedOfferCount;
    default:
      return 0;
  }
}

function compareNullableDates(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return 1;
  if (b) return -1;
  return 0;
}
