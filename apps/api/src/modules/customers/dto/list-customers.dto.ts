import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const CUSTOMER_SORT_FIELDS = [
  'name',
  'createdAt',
  'lastRequestAt',
  'requestCount',
  'offerCount',
  'acceptedOfferCount',
] as const;

export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

export const CUSTOMER_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type CustomerSortDirection = (typeof CUSTOMER_SORT_DIRECTIONS)[number];

const SORT_FIELD_SET = new Set<string>(CUSTOMER_SORT_FIELDS);

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

function normalizeSortField(value: unknown): CustomerSortField | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SORT_FIELD_SET.has(trimmed) ? (trimmed as CustomerSortField) : undefined;
}

function normalizeSortDirection(value: unknown): CustomerSortDirection | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  return lower === 'asc' || lower === 'desc' ? lower : undefined;
}

export class ListCustomersDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  city?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  lastRequestFrom?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  lastRequestTo?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeSortField(value))
  @IsEnum(CUSTOMER_SORT_FIELDS)
  sortBy?: CustomerSortField;

  @IsOptional()
  @Transform(({ value }) => normalizeSortDirection(value))
  @IsEnum(CUSTOMER_SORT_DIRECTIONS)
  sortDir?: CustomerSortDirection;
}
