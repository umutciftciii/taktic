import { SeoNotFoundStatus, SeoRedirectOrigin, SeoRedirectType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SEO_INDEX_REASON_CODES } from '../seo-index-eligibility';

/**
 * SEO-004 — the request shapes of the admin SEO routes. Paths arrive as
 * strings and are judged by `normalizeSeoPath` in the service, which answers
 * a refusal code; the DTO only bounds their size.
 */

function toInt(value: unknown): unknown {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return value;
}

function toBool(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export const SEO_PAGE_SIZE_DEFAULT = 25;
export const SEO_PAGE_SIZE_MAX = 100;

export class SeoPageQueryDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(SEO_PAGE_SIZE_MAX)
  pageSize?: number;
}

export const SEO_PAGE_TYPES = ['CATEGORY', 'PROVIDER', 'SHOWCASE_CARD', 'SHOWCASE_SHELF'] as const;
export type SeoPageType = (typeof SEO_PAGE_TYPES)[number];

export class NonIndexablePagesQueryDto extends SeoPageQueryDto {
  @IsOptional()
  @IsIn(SEO_PAGE_TYPES)
  type?: SeoPageType;

  @IsOptional()
  @IsIn(SEO_INDEX_REASON_CODES)
  reason?: (typeof SEO_INDEX_REASON_CODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class SlugListQueryDto extends SeoPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ChangeSlugDto {
  /** Free text; the server derives the slug (Turkish letters transliterated). */
  @IsString()
  @MaxLength(200)
  slug!: string;
}

export class SlugPreviewQueryDto {
  @IsString()
  @MaxLength(200)
  slug!: string;
}

export class RedirectListQueryDto extends SeoPageQueryDto {
  @IsOptional()
  @Transform(({ value }) => toBool(value))
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsEnum(SeoRedirectOrigin)
  origin?: SeoRedirectOrigin;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class CreateRedirectDto {
  @IsString()
  @MaxLength(400)
  sourcePath!: string;

  @IsString()
  @MaxLength(400)
  targetPath!: string;

  @IsEnum(SeoRedirectType)
  type!: SeoRedirectType;

  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class UpdateRedirectDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  targetPath?: string;

  @IsOptional()
  @IsEnum(SeoRedirectType)
  type?: SeoRedirectType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DeactivateRedirectDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class NotFoundListQueryDto extends SeoPageQueryDto {
  @IsOptional()
  @IsEnum(SeoNotFoundStatus)
  status?: SeoNotFoundStatus;

  /** Only paths seen on at least this many distinct days (noise filter). */
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(365)
  minSeenDays?: number;
}

export class ApproveSuggestionDto {
  /** Absent: the recorded deterministic candidate, if there is one. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  targetPath?: string;

  @IsOptional()
  @IsEnum(SeoRedirectType)
  type?: SeoRedirectType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RejectSuggestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
