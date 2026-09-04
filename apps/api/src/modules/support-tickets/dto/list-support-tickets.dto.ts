import { SupportTicketStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SUPPORT_TICKET_PAGE_MAX_SIZE } from '../support-tickets.config';

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The admin list's query: one optional status filter and a page.
 *
 * There is no customer filter and no free-text search in this version. Both are
 * real asks and neither is this one, and a half-built search that only matches
 * a subject would be worse than none.
 */
export class ListSupportTicketsDto {
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(SUPPORT_TICKET_PAGE_MAX_SIZE)
  pageSize?: number;
}
