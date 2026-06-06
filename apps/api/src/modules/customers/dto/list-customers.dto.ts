import { Transform } from 'class-transformer';
import {
  IsIn,
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

// Transform fonksiyonları "absent" değeri (undefined/null/boş string) için undefined döndürür,
// böylece @IsOptional() doğru çalışır. Geçersiz değerleri ise OLDUĞU GİBİ geri verir, ki sonraki
// validator (@IsInt, @IsIn, ...) bunu 400 ile reddedebilsin. Eski permissive pattern (invalid→undefined)
// silently default'lara düşüyordu — burada onu tekrar etmiyoruz.

function toIntOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (!/^-?\d+$/.test(trimmed)) return value;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

function trimOrUndefined(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSortFieldOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed;
}

function normalizeSortDirectionOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const lower = trimmed.toLowerCase();
  return lower === 'asc' || lower === 'desc' ? lower : trimmed;
}

export class ListCustomersDto {
  @IsOptional()
  @Transform(({ value }) => toIntOrPass(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toIntOrPass(value))
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
  @Transform(({ value }) => normalizeSortFieldOrPass(value))
  @IsIn(CUSTOMER_SORT_FIELDS as readonly string[])
  sortBy?: CustomerSortField;

  @IsOptional()
  @Transform(({ value }) => normalizeSortDirectionOrPass(value))
  @IsIn(CUSTOMER_SORT_DIRECTIONS as readonly string[])
  sortDir?: CustomerSortDirection;
}
