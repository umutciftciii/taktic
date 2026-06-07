import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  ListUsersDto,
  UserSortDirection,
  UserSortField,
} from './dto/list-users.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type UserListItem = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

    const where: Prisma.UserWhereInput = {
      role: UserRole.SUPER_ADMIN,
    };

    if (filters.q) {
      const term = filters.q;
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }

    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive === 'true';
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
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          passwordHash: true,
        },
      }),
    ]);

    const userIds = rows.map((row) => row.id);

    const sessionCounts =
      userIds.length === 0
        ? ([] as Array<{ userId: string; _count: { _all: number } }>)
        : await this.prisma.session.groupBy({
            by: ['userId'],
            where: {
              userId: { in: userIds },
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            _count: { _all: true },
          });

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
      hasPassword: row.passwordHash !== null,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
    const user = await this.prisma.user.findFirst({
      where: { id, role: UserRole.SUPER_ADMIN },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
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

    const activeSessionCount = await this.prisma.session.count({
      where: {
        userId: id,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive,
        hasPassword,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      metrics: {
        activeSessionCount,
      },
    };
  }

  async updateStatus(id: string, dto: UpdateUserStatusDto, actor: AuthUser) {
    const target = await this.prisma.user.findFirst({
      where: { id, role: UserRole.SUPER_ADMIN },
      select: { id: true, role: true, isActive: true },
    });

    if (!target) {
      throw new NotFoundException('User not found');
    }

    if (target.isActive === dto.isActive) {
      return { id: target.id, isActive: target.isActive };
    }

    if (dto.isActive === false) {
      if (actor.id === target.id) {
        throw new ConflictException('Kendi hesabınızı pasifleştiremezsiniz.');
      }

      const activeSuperAdminCount = await this.prisma.user.count({
        where: { role: UserRole.SUPER_ADMIN, isActive: true },
      });
      if (activeSuperAdminCount <= 1) {
        throw new ConflictException('Son aktif süper admin pasifleştirilemez.');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data: { isActive: dto.isActive },
      select: { id: true, isActive: true },
    });

    return updated;
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
