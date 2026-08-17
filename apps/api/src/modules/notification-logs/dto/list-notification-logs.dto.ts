import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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

export class ListNotificationLogsDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  /**
   * Free-form on purpose: the column is a string, and a row written by an older
   * build must stay reachable even when its template is no longer sent.
   */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @MaxLength(120)
  template?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @MaxLength(64)
  requestId?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @MaxLength(64)
  userId?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  from?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  to?: string;
}
