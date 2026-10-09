import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * ADMIN-SEARCH-PAGINATION-001: the operator's offer list is paged by the API.
 * The last page an operator can ask for, so `(page - 1) * pageSize` stays a
 * row offset the database can take.
 */
export const OFFER_LIST_MAX_PAGE = 1_000_000;
export const OFFER_LIST_DEFAULT_PAGE_SIZE = 50;
export const OFFER_LIST_MAX_PAGE_SIZE = 100;

/** The automatic refund rule's verdict, as the list filters by it. */
export const OFFER_REFUND_ACTION_FILTERS = ['FULL_REFUND', 'NO_REFUND'] as const;
export type OfferRefundActionFilter = (typeof OFFER_REFUND_ACTION_FILTERS)[number];

/** Absent (undefined, null, blank) is absent; anything else goes to the validators as it came. */
function toIntOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (!/^-?\d+$/.test(trimmed)) return value;
    return Number.parseInt(trimmed, 10);
  }
  return value;
}

export class ListOffersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  providerId?: string;

  @IsOptional()
  @IsString()
  requestId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  categorySlug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsISO8601()
  submittedFrom?: string;

  @IsOptional()
  @IsISO8601()
  submittedTo?: string;

  /** Was applied by the admin screen to the whole list; now a filter of the query itself. */
  @IsOptional()
  @IsIn(OFFER_REFUND_ACTION_FILTERS as readonly string[])
  refundAction?: OfferRefundActionFilter;

  @IsOptional()
  @Transform(({ value }) => toIntOrPass(value))
  @IsInt()
  @Min(1)
  @Max(OFFER_LIST_MAX_PAGE)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toIntOrPass(value))
  @IsInt()
  @Min(1)
  @Max(OFFER_LIST_MAX_PAGE_SIZE)
  pageSize?: number;
}
