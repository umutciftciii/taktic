import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export type OfferAllowanceReportGroupBy = 'day' | 'month' | 'year';

export const OFFER_ALLOWANCE_REPORT_GROUP_BY_VALUES: OfferAllowanceReportGroupBy[] = ['day', 'month', 'year'];

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * SHOWCASE-ALLOWANCE-002 — the filters of `GET /finance/offer-allowances`.
 *
 * `from` / `to` are Istanbul civil days, both optional: a missing `from` is the
 * beginning of the data, a missing `to` is "until now". The same window is
 * applied to three different clocks (grant start, usage time, right granted);
 * the response names which one each section reads.
 */
export class OfferAllowanceReportDto {
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be in YYYY-MM-DD format' })
  from?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be in YYYY-MM-DD format' })
  to?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsIn(OFFER_ALLOWANCE_REPORT_GROUP_BY_VALUES)
  groupBy?: OfferAllowanceReportGroupBy;

  /** A ShowcasePackage id. */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @MaxLength(64)
  packageId?: string;

  /** A ProviderProfile id. */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @MaxLength(64)
  providerId?: string;

  /** A ServiceCategory id. */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @MaxLength(64)
  categoryId?: string;

  /** The provider breakdown's page; the other breakdowns are bounded and unpaged. */
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
}
