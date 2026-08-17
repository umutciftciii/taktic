import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListNotificationLogsDto } from './dto/list-notification-logs.dto';
import { notificationLogSelect, toSafeNotificationLog } from './notification-log.projection';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Read-only view over the notification audit trail.
 *
 * Every method here reads and nothing else: this screen exists so an operator
 * can see what the platform tried to send, and it deliberately offers no way to
 * resend, edit, delete or re-classify a row. Running a query must also leave no
 * trace of its own — these endpoints never dispatch, so they never create the
 * kind of log they are displaying.
 */
@Injectable()
export class NotificationLogService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listNotificationLogs(filters: ListNotificationLogsDto) {
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);
    const where = buildNotificationLogWhere(filters);

    const [total, rows] = await Promise.all([
      this.prisma.notificationLog.count({ where }),
      this.prisma.notificationLog.findMany({
        where,
        // Newest first. `id` breaks the tie so a page boundary cannot show the
        // same row twice when several rows share a millisecond.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: notificationLogSelect,
      }),
    ]);

    return {
      items: rows.map(toSafeNotificationLog),
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
    };
  }

  async getNotificationLog(id: string) {
    const row = await this.prisma.notificationLog.findUnique({
      where: { id },
      select: notificationLogSelect,
    });

    if (!row) {
      throw new NotFoundException('Notification log not found');
    }

    return toSafeNotificationLog(row);
  }
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_PAGE_SIZE);
}

function buildNotificationLogWhere(
  filters: ListNotificationLogsDto,
): Prisma.NotificationLogWhereInput {
  const from = parseBoundary(filters.from, 'from');
  const to = parseBoundary(filters.to, 'to');

  if (from && to && from > to) {
    throw new BadRequestException('from cannot be after to');
  }

  return {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.template ? { template: filters.template } : {}),
    ...(filters.requestId ? { requestId: filters.requestId } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };
}

function parseBoundary(value: string | undefined, fieldName: string): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${fieldName} must be a valid ISO-8601 date`);
  }

  return parsed;
}
