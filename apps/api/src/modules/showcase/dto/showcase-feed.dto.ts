import { ShowcaseCardKind } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SHOWCASE_FEED_MAX_LIMIT } from '../showcase.constants';

/**
 * What a visitor may ask the vitrin feed for.
 *
 * `city` is required and the service refuses without it. A national list would
 * show people businesses that cannot reach them and would show providers'
 * placements to visitors they did not pay to reach; neither is what this
 * product sells.
 *
 * There is no ordering parameter and there never will be. The order is the
 * product — see `ShowcaseFeedService` — and a client that could choose it could
 * undo the rotation that keeps one business from filling the page.
 */
export class ShowcaseFeedQueryDto {
  @IsString()
  @MaxLength(80)
  city!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  neighborhood?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string;

  @IsOptional()
  @IsEnum(ShowcaseCardKind)
  kind?: ShowcaseCardKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SHOWCASE_FEED_MAX_LIMIT)
  limit?: number;

  /** Opaque keyset cursor from a previous page. A bad one is ignored. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
