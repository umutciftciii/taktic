import { ShowcaseCardKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  SHOWCASE_AREA_MAX_COUNT,
  SHOWCASE_IMAGE_URL_MAX_LENGTH,
  SHOWCASE_MAX_LISTED_PRICE_MINOR,
  SHOWCASE_SCOPE_ITEM_MAX_LENGTH,
  SHOWCASE_SCOPE_MAX_ITEMS,
  SHOWCASE_SLA_NORMAL_MAX_HOURS,
  SHOWCASE_SLA_NORMAL_MIN_HOURS,
  SHOWCASE_SLA_URGENT_MAX_HOURS,
  SHOWCASE_SLA_URGENT_MIN_HOURS,
  SHOWCASE_SUMMARY_MAX_LENGTH,
  SHOWCASE_TITLE_MAX_LENGTH,
} from '../showcase.constants';
import { ShowcaseAreaDto } from './showcase-area.dto';

/**
 * The content of one card version, as a provider states it.
 *
 * Shared by the create and the edit endpoints through
 * {@link UpdateShowcaseCardDto}, which extends it, because a card's content is
 * the same shape however it arrives. What create adds — the kind and the
 * category — are the two things that never change afterwards, which is exactly
 * why they are not on the update body.
 *
 * `listedServicePriceAmount` is validated for shape here and for *meaning* in
 * the service, against the card's kind: a SERVICE card must carry one and a
 * PROMOTION card must not. A DTO cannot see the kind on an edit — it lives on
 * the stored card — so the rule cannot live here, and the database CHECK holds
 * it whichever path writes.
 */
export class ShowcaseCardContentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(SHOWCASE_TITLE_MAX_LENGTH)
  title!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(SHOWCASE_SUMMARY_MAX_LENGTH)
  summary!: string;

  /**
   * What the standard scope includes, and what it deliberately does not.
   *
   * Both required and both non-empty: a fixed price for an unstated scope is the
   * one claim this product must never carry, and "hariç" is the half a customer
   * needs most. The same rule is a CHECK on the table.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHOWCASE_SCOPE_MAX_ITEMS)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(SHOWCASE_SCOPE_ITEM_MAX_LENGTH, { each: true })
  scopeIncluded!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHOWCASE_SCOPE_MAX_ITEMS)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(SHOWCASE_SCOPE_ITEM_MAX_LENGTH, { each: true })
  scopeExcluded!: string[];

  /** Minor units — kuruş. Never a decimal, for the reason every other amount in
   * this schema is an integer: a float cannot hold 19.90 exactly. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SHOWCASE_MAX_LISTED_PRICE_MINOR)
  listedServicePriceAmount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(SHOWCASE_IMAGE_URL_MAX_LENGTH)
  imageUrl?: string | null;

  @IsOptional()
  @IsInt()
  @Min(SHOWCASE_SLA_URGENT_MIN_HOURS)
  @Max(SHOWCASE_SLA_URGENT_MAX_HOURS)
  responseSlaUrgentHours?: number;

  @IsOptional()
  @IsInt()
  @Min(SHOWCASE_SLA_NORMAL_MIN_HOURS)
  @Max(SHOWCASE_SLA_NORMAL_MAX_HOURS)
  responseSlaNormalHours?: number;

  /**
   * Where the card claims to work. At least one, and every one of them checked
   * against the provider's own service areas in the service.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHOWCASE_AREA_MAX_COUNT)
  @ValidateNested({ each: true })
  @Type(() => ShowcaseAreaDto)
  areas!: ShowcaseAreaDto[];
}

export class CreateShowcaseCardDto extends ShowcaseCardContentDto {
  /** Fixed for the life of the card. There is no endpoint that changes it. */
  @IsEnum(ShowcaseCardKind)
  kind!: ShowcaseCardKind;

  /**
   * Fixed for the life of the card, for a structural reason rather than a
   * product one: the category lives on the card and not on a version, so a
   * change to it could not be reviewed. See the module's own notes.
   */
  @IsString()
  @MinLength(1)
  categoryId!: string;
}

/** An edit to a card's content. The kind and the category are not editable. */
export class UpdateShowcaseCardDto extends ShowcaseCardContentDto {}
