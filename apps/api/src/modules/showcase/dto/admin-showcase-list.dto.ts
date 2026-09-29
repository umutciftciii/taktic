import { ShowcaseLeadStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Server-side pages for the two vitrin lists that used to stop at 200 rows
 * (API-HARDENING-001). The same shape the package-refund list already uses:
 * `page` from 1, `pageSize` up to 100, and an answer that carries `total` so a
 * screen never has to present a partial page as the whole list.
 */
export const SHOWCASE_ADMIN_PAGE_DEFAULT_SIZE = 50;
export const SHOWCASE_ADMIN_PAGE_MAX_SIZE = 100;

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  // Digits only: "2abc" is not page 2, and parseInt would say it was.
  return /^\d+$/.test(String(value)) ? Number(value) : Number.NaN;
}

function trimmed(value: unknown) {
  if (typeof value !== 'string') return value;
  const next = value.trim();
  return next === '' ? undefined : next;
}

class ShowcaseAdminPageDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(SHOWCASE_ADMIN_PAGE_MAX_SIZE)
  pageSize?: number;
}

export class ListShowcaseLeadsDto extends ShowcaseAdminPageDto {
  @IsOptional()
  @Transform(({ value }) => trimmed(value))
  @IsEnum(ShowcaseLeadStatus)
  status?: ShowcaseLeadStatus;

  @IsOptional()
  @Transform(({ value }) => trimmed(value))
  @IsString()
  @MaxLength(64)
  providerId?: string;
}

export class ListShowcasePriceTermsDto extends ShowcaseAdminPageDto {
  @IsOptional()
  @Transform(({ value }) => trimmed(value))
  @IsString()
  @MaxLength(64)
  providerId?: string;

  @IsOptional()
  @Transform(({ value }) => trimmed(value))
  @IsString()
  @MaxLength(64)
  cardId?: string;

  @IsOptional()
  @Transform(({ value }) => trimmed(value))
  @IsString()
  @MaxLength(64)
  termsVersion?: string;
}

export function showcaseAdminPage(input: { page?: number; pageSize?: number }) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? SHOWCASE_ADMIN_PAGE_DEFAULT_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}
