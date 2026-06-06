import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CustomerOrigin, OfferStatus, Prisma, UserRole } from '@prisma/client';
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
  requestCount: number;
  offerCount: number;
  acceptedOfferCount: number;
  lastRequestAt: Date | null;
  lastRequestCity: string | null;
};

@Injectable()
export class CustomersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(filters: ListCustomersDto) {
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);
    const sortBy: CustomerSortField = filters.sortBy ?? 'lastRequestAt';
    const sortDir: CustomerSortDirection = filters.sortDir ?? 'desc';

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
      },
    });

    const total = customers.length;
    const customerIds = customers.map((customer) => customer.id);

    const [requestStats, offerStats, lastRequests, anonymousRequestCount] = await Promise.all([
      customerIds.length === 0
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
      customerIds.length === 0
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
      customerIds.length === 0
        ? Promise.resolve([] as Array<{ customerId: string; city: string; submittedAt: Date }>)
        : this.prisma.$queryRaw<
            Array<{ customerId: string; city: string; submittedAt: Date }>
          >(Prisma.sql`
            SELECT DISTINCT ON ("customerId") "customerId", "city", "submittedAt"
            FROM "ServiceRequest"
            WHERE "customerId" IN (${Prisma.join(customerIds)})
            ORDER BY "customerId", "submittedAt" DESC, "id" DESC
          `),
      this.prisma.serviceRequest.count({ where: { customerId: null } }),
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
      items: pagedItems,
      total,
      page,
      pageSize,
      hasNextPage,
      meta: {
        anonymousRequestCount,
      },
    };
  }

  async detail(id: string) {
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
        passwordHash: true,
      },
    });

    if (!user || user.role !== UserRole.CUSTOMER) {
      throw new NotFoundException('Customer not found');
    }

    const hasPassword = user.passwordHash !== null;

    const [
      requestCount,
      offerCountAgg,
      acceptedOfferCountAgg,
      lastRequest,
      recentRequestRows,
      recentOfferRows,
      acceptedOfferRows,
    ] = await Promise.all([
      this.prisma.serviceRequest.count({ where: { customerId: id } }),
      this.prisma.offer.count({ where: { request: { customerId: id } } }),
      this.prisma.offer.count({
        where: { request: { customerId: id }, status: OfferStatus.ACCEPTED },
      }),
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
      this.prisma.offer.findMany({
        where: { request: { customerId: id } },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        take: RECENT_OFFERS_LIMIT,
        select: {
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
        },
      }),
      this.prisma.offer.findMany({
        where: { request: { customerId: id }, status: OfferStatus.ACCEPTED },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
        take: ACCEPTED_OFFERS_LIMIT,
        select: {
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
        },
      }),
    ]);

    const recentRequests = recentRequestRows.map((row) => ({
      id: row.id,
      requestNumber: row.requestNumber,
      categoryName: row.category.name,
      city: row.city,
      district: row.district,
      status: row.status,
      qualityLabel: qualityLabel(row.qualityScore),
      submittedAt: row.submittedAt,
      offerCount: row._count.offers,
    }));

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
        hasPassword,
      },
      metrics: {
        requestCount,
        offerCount: offerCountAgg,
        acceptedOfferCount: acceptedOfferCountAgg,
        lastRequestAt: lastRequest?.submittedAt ?? null,
      },
      recentRequests,
      recentOffers: recentOfferRows.map(mapOffer),
      acceptedOffers: acceptedOfferRows.map(mapOffer),
    };
  }

  async listNotes(customerId: string) {
    await this.assertCustomerExists(customerId);

    const notes = await this.prisma.customerNote.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        note: true,
        createdAt: true,
        updatedAt: true,
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return { items: notes };
  }

  async createNote(customerId: string, dto: CreateCustomerNoteDto, actorId: string) {
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
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return note;
  }

  async updateStatus(customerId: string, dto: UpdateCustomerStatusDto) {
    await this.assertCustomerExists(customerId);

    const updated = await this.prisma.user.update({
      where: { id: customerId },
      data: { isActive: dto.isActive },
      select: { id: true, isActive: true },
    });

    return updated;
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
