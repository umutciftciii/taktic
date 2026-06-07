import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  CustomerOrigin,
  OfferStatus,
  Prisma,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ListUsersDto,
  UserSortDirection,
  UserSortField,
} from './dto/list-users.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type UserListItem = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  customerOrigin: CustomerOrigin | null;
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  providerProfileCount: number;
  activeSessionCount: number;
};

@Injectable()
export class UsersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(filters: ListUsersDto) {
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);
    const sortBy: UserSortField = filters.sortBy ?? 'createdAt';
    const sortDir: UserSortDirection = filters.sortDir ?? 'desc';

    const createdRange = parseDateRange(
      filters.createdFrom,
      filters.createdTo,
      'createdFrom',
      'createdTo',
    );
    const lastLoginRange = parseDateRange(
      filters.lastLoginFrom,
      filters.lastLoginTo,
      'lastLoginFrom',
      'lastLoginTo',
    );

    const where: Prisma.UserWhereInput = {};

    if (filters.q) {
      const term = filters.q;
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }

    if (filters.role) {
      where.role = filters.role as UserRole;
    }

    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive === 'true';
    }

    if (filters.customerOrigin) {
      where.customerOrigin = filters.customerOrigin as CustomerOrigin;
    }

    if (filters.hasPassword !== undefined) {
      where.passwordHash = filters.hasPassword === 'true' ? { not: null } : null;
    }

    if (createdRange) {
      where.createdAt = createdRange;
    }
    if (lastLoginRange) {
      where.lastLoginAt = lastLoginRange;
    }

    const orderBy = buildUserOrderBy(sortBy, sortDir);

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          customerOrigin: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          passwordHash: true,
        },
      }),
    ]);

    const userIds = rows.map((row) => row.id);

    const [providerCounts, sessionCounts] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve([] as Array<{ userId: string | null; _count: { _all: number } }>)
        : this.prisma.providerProfile.groupBy({
            by: ['userId'],
            where: { userId: { in: userIds } },
            _count: { _all: true },
          }),
      userIds.length === 0
        ? Promise.resolve([] as Array<{ userId: string; _count: { _all: number } }>)
        : this.prisma.session.groupBy({
            by: ['userId'],
            where: {
              userId: { in: userIds },
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            _count: { _all: true },
          }),
    ]);

    const providerCountByUser = new Map<string, number>();
    for (const row of providerCounts) {
      if (!row.userId) continue;
      providerCountByUser.set(row.userId, row._count._all);
    }

    const sessionCountByUser = new Map<string, number>();
    for (const row of sessionCounts) {
      sessionCountByUser.set(row.userId, row._count._all);
    }

    const items: UserListItem[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      role: row.role,
      isActive: row.isActive,
      customerOrigin: row.customerOrigin,
      hasPassword: row.passwordHash !== null,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      providerProfileCount: providerCountByUser.get(row.id) ?? 0,
      activeSessionCount: sessionCountByUser.get(row.id) ?? 0,
    }));

    const hasNextPage = page * pageSize < total;

    return {
      items,
      total,
      page,
      pageSize,
      hasNextPage,
    };
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        customerOrigin: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        passwordHash: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const hasPassword = user.passwordHash !== null;
    const now = new Date();

    const [
      activeSessionCount,
      providerProfileCount,
      providerProfiles,
      customerRequestCount,
      customerOfferCount,
      acceptedOfferCount,
      lastCustomerRequest,
    ] = await Promise.all([
      this.prisma.session.count({
        where: {
          userId: id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      }),
      this.prisma.providerProfile.count({ where: { userId: id } }),
      user.role === UserRole.PROVIDER
        ? this.prisma.providerProfile.findMany({
            where: { userId: id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              businessName: true,
              status: true,
              city: true,
              district: true,
              createdAt: true,
            },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              businessName: string;
              status: ProviderStatus;
              city: string;
              district: string;
              createdAt: Date;
            }>,
          ),
      user.role === UserRole.CUSTOMER
        ? this.prisma.serviceRequest.count({ where: { customerId: id } })
        : Promise.resolve(0),
      user.role === UserRole.CUSTOMER
        ? this.prisma.offer.count({ where: { request: { customerId: id } } })
        : Promise.resolve(0),
      user.role === UserRole.CUSTOMER
        ? this.prisma.offer.count({
            where: { request: { customerId: id }, status: OfferStatus.ACCEPTED },
          })
        : Promise.resolve(0),
      user.role === UserRole.CUSTOMER
        ? this.prisma.serviceRequest.findFirst({
            where: { customerId: id },
            orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
            select: { submittedAt: true },
          })
        : Promise.resolve(null as { submittedAt: Date } | null),
    ]);

    const customerSummary =
      user.role === UserRole.CUSTOMER
        ? {
            requestCount: customerRequestCount,
            offerCount: customerOfferCount,
            acceptedOfferCount,
            lastRequestAt: lastCustomerRequest?.submittedAt ?? null,
          }
        : null;

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive,
        customerOrigin: user.customerOrigin,
        hasPassword,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      metrics: {
        activeSessionCount,
        providerProfileCount,
        customerRequestCount: user.role === UserRole.CUSTOMER ? customerRequestCount : 0,
        customerOfferCount: user.role === UserRole.CUSTOMER ? customerOfferCount : 0,
      },
      providerProfiles,
      customerSummary,
    };
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

function buildUserOrderBy(
  sortBy: UserSortField,
  sortDir: UserSortDirection,
): Prisma.UserOrderByWithRelationInput[] {
  const direction = sortDir === 'asc' ? Prisma.SortOrder.asc : Prisma.SortOrder.desc;
  const tiebreaker: Prisma.UserOrderByWithRelationInput = { id: Prisma.SortOrder.asc };
  switch (sortBy) {
    case 'name':
      return [{ name: { sort: direction, nulls: 'last' } }, tiebreaker];
    case 'email':
      return [{ email: { sort: direction, nulls: 'last' } }, tiebreaker];
    case 'role':
      return [{ role: direction }, tiebreaker];
    case 'isActive':
      return [{ isActive: direction }, tiebreaker];
    case 'lastLoginAt':
      return [{ lastLoginAt: { sort: direction, nulls: 'last' } }, tiebreaker];
    case 'createdAt':
    default:
      return [{ createdAt: direction }, tiebreaker];
  }
}
