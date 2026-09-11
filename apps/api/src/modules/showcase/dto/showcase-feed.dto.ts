import { ShowcaseCardKind } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SHOWCASE_FEED_MAX_LIMIT } from '../showcase.constants';

/**
 * What a visitor may ask the vitrin feed for.
 *
 * ## `city` is optional, and that is a deliberate reversal
 *
 * An earlier version of this feature refused a feed request with no location,
 * on the reasoning that showing somebody a business which cannot reach them is
 * the opposite of what a placement sells.
 *
 * That reasoning turned out to describe a *directory*, and vitrin is not one.
 * A business buys a card, the card goes on the home page, and every visitor
 * sees it — what keeps the promise honest is not hiding the card, it is saying
 * on the card itself, unmissably, which area it is good for. The refusal bought
 * nothing and cost the whole surface: a visitor who had not yet picked a
 * province saw an empty shelf, so the cards a provider had paid for were
 * invisible to everybody who arrived without a query string.
 *
 * So a location now *narrows* the shelf rather than unlocking it, and the
 * coverage promise is enforced where it actually matters — on the server, when
 * a direct lead is opened. See `ShowcaseLeadService.createLead`: a customer may
 * read any card, and may only write to one that genuinely serves the address
 * they typed.
 *
 * There is no ordering parameter and there never will be. The order is the
 * product — see `ShowcaseFeedService` — and a client that could choose it could
 * undo the rotation that keeps one business from filling the page.
 */
export class ShowcaseFeedQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

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
