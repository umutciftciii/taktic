import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

export const USER_SORT_FIELDS = [
  'name',
  'email',
  'role',
  'createdAt',
  'lastLoginAt',
  'isActive',
] as const;

export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export const USER_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type UserSortDirection = (typeof USER_SORT_DIRECTIONS)[number];

export const USER_ROLE_VALUES = ['SUPER_ADMIN', 'CUSTOMER', 'PROVIDER'] as const;
export type UserRoleValue = (typeof USER_ROLE_VALUES)[number];

export const USER_CUSTOMER_ORIGIN_VALUES = [
  'REGISTERED',
  'AUTO_CREATED_REQUEST',
  'ADMIN_CREATED',
  'IMPORTED',
] as const;
export type UserCustomerOriginValue = (typeof USER_CUSTOMER_ORIGIN_VALUES)[number];

export const USER_BOOLEAN_VALUES = ['true', 'false'] as const;
export type UserBooleanValue = (typeof USER_BOOLEAN_VALUES)[number];

// Transform fonksiyonları "absent" değeri (undefined/null/boş string) için undefined döndürür,
// böylece @IsOptional() doğru çalışır. Geçersiz değerleri ise OLDUĞU GİBİ geri verir, ki sonraki
// validator (@IsInt, @IsIn, ...) bunu 400 ile reddedebilsin.

function toIntOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
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

function normalizeUpperOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.toUpperCase();
}

function normalizeLowerOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.toLowerCase();
}

function normalizeSortFieldOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed;
}

export class ListUsersDto {
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
  @Transform(({ value }) => normalizeUpperOrPass(value))
  @IsIn(USER_ROLE_VALUES as readonly string[])
  role?: UserRoleValue;

  @IsOptional()
  @Transform(({ value }) => normalizeLowerOrPass(value))
  @IsIn(USER_BOOLEAN_VALUES as readonly string[])
  isActive?: UserBooleanValue;

  @IsOptional()
  @Transform(({ value }) => normalizeUpperOrPass(value))
  @IsIn(USER_CUSTOMER_ORIGIN_VALUES as readonly string[])
  customerOrigin?: UserCustomerOriginValue;

  @IsOptional()
  @Transform(({ value }) => normalizeLowerOrPass(value))
  @IsIn(USER_BOOLEAN_VALUES as readonly string[])
  hasPassword?: UserBooleanValue;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  lastLoginFrom?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  lastLoginTo?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeSortFieldOrPass(value))
  @IsIn(USER_SORT_FIELDS as readonly string[])
  sortBy?: UserSortField;

  @IsOptional()
  @Transform(({ value }) => normalizeLowerOrPass(value))
  @IsIn(USER_SORT_DIRECTIONS as readonly string[])
  sortDir?: UserSortDirection;
}
