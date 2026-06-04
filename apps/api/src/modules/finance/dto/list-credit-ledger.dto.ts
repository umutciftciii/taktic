import { Transform } from 'class-transformer';
import { CreditTransactionType } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

const CREDIT_TRANSACTION_TYPES = Object.values(CreditTransactionType);

function splitCsv(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

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

export class ListCreditLedgerDto {
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
  @IsString()
  providerId?: string;

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray()
  @IsEnum(CreditTransactionType, { each: true })
  type?: CreditTransactionType[];

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  referenceType?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  from?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  q?: string;
}

export { CREDIT_TRANSACTION_TYPES };
