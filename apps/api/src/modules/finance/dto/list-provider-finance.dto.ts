import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const PROVIDER_FINANCE_SORT_FIELDS = [
  'businessName',
  'currentBalance',
  'totalPaidAmount',
  'totalCreditsPurchased',
  'totalCreditsSpent',
  'totalCreditsRefunded',
  'manualNetCredits',
  'lastPaymentAt',
  'lastTransactionAt',
] as const;

export type ProviderFinanceSortField = (typeof PROVIDER_FINANCE_SORT_FIELDS)[number];

export const PROVIDER_FINANCE_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type ProviderFinanceSortDirection = (typeof PROVIDER_FINANCE_SORT_DIRECTIONS)[number];

const SORT_FIELD_SET = new Set<string>(PROVIDER_FINANCE_SORT_FIELDS);

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

function normalizeSortField(value: unknown): ProviderFinanceSortField | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SORT_FIELD_SET.has(trimmed) ? (trimmed as ProviderFinanceSortField) : undefined;
}

function normalizeSortDirection(value: unknown): ProviderFinanceSortDirection | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  return lower === 'asc' || lower === 'desc' ? lower : undefined;
}

export class ListProviderFinanceDto {
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
  @Transform(({ value }) => normalizeSortField(value))
  @IsEnum(PROVIDER_FINANCE_SORT_FIELDS)
  sortBy?: ProviderFinanceSortField;

  @IsOptional()
  @Transform(({ value }) => normalizeSortDirection(value))
  @IsEnum(PROVIDER_FINANCE_SORT_DIRECTIONS)
  sortDir?: ProviderFinanceSortDirection;
}
