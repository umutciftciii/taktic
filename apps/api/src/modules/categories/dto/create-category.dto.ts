import { ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { CATEGORY_ICON_KEYS, CategoryIconKey } from '../category-visuals';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  /**
   * Mandatory on create for a service, and only for a service: a LEAF must
   * never come into existence without a price, otherwise it silently cannot
   * receive offers. @Min(1) rejects 0 and negatives, @IsInt rejects non-numeric
   * and fractional input.
   *
   * A GROUP is a folder and a ROUTER is a question; no offer can ever be made
   * on either, so demanding a price for them would be asking for a number
   * nothing reads. @ValidateIf rather than @IsOptional so a LEAF — including
   * every payload that names no kind at all, which defaults to LEAF — still has
   * to carry one.
   */
  @ValidateIf((dto: CreateCategoryDto) => (dto.kind ?? ServiceCategoryKind.LEAF) === ServiceCategoryKind.LEAF)
  @IsInt()
  @Min(1)
  offerCreditCost!: number;

  @IsOptional()
  @IsString()
  parentId?: string | null;

  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @IsOptional()
  @IsString()
  coverImageUrl?: string | null;

  @IsOptional()
  @IsIn([...CATEGORY_ICON_KEYS, '', null])
  iconKey?: CategoryIconKey | '' | null;

  /**
   * What the category is in the tree. Defaults to LEAF — a plain service that
   * takes requests, which is what every category created before the taxonomy
   * existed is.
   */
  @IsOptional()
  @IsEnum(ServiceCategoryKind)
  kind?: ServiceCategoryKind;

  /**
   * Operational readiness. Defaults to ACTIVE so the admin "create category"
   * form keeps behaving as it did; an expansion category is created DRAFT by
   * sending it explicitly.
   */
  @IsOptional()
  @IsEnum(ServiceCategoryStatus)
  status?: ServiceCategoryStatus;

  /**
   * The pre-taxonomy way of saying the same thing, still accepted so every
   * client written before `status` existed keeps working unchanged.
   *
   * `status` wins when both are sent. On its own, true means ACTIVE and false
   * means INACTIVE — never DRAFT, because a boolean cannot express "not
   * released yet" and guessing it would put an unfinished category one
   * checkbox away from the public catalogue.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
