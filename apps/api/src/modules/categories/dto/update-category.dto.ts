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

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  /**
   * Optional on update (a partial payload leaves it untouched), but when present
   * it must be a whole number >= 1.
   *
   * @ValidateIf on `!== undefined` rather than @IsOptional deliberately:
   * @IsOptional also skips validation for `null`, which would let
   * `{offerCreditCost: null}` through and unprice a live category. Making a
   * category unsellable is done with isActive=false, never by removing its
   * price, so an explicit null must fail validation.
   */
  @ValidateIf((dto: UpdateCategoryDto) => dto.offerCreditCost !== undefined)
  @IsInt()
  @Min(1)
  offerCreditCost?: number;

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

  @IsOptional()
  @IsEnum(ServiceCategoryKind)
  kind?: ServiceCategoryKind;

  @IsOptional()
  @IsEnum(ServiceCategoryStatus)
  status?: ServiceCategoryStatus;

  /** See CreateCategoryDto.isActive: kept so pre-taxonomy clients still work. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Whether providers may sign themselves up for this service.
   *
   * Only meaningful on a DRAFT leaf — see isProviderEnrollmentOpen — and
   * CategoriesService refuses it on anything else rather than storing a value
   * nothing reads.
   */
  @IsOptional()
  @IsBoolean()
  providerEnrollmentOpen?: boolean;

  /**
   * Whether this category may be put inside a CATEGORY_UNLIMITED offer
   * package's scope.
   *
   * Defaults to false and stays false until an admin sets it. Regulated and
   * high-value categories are therefore excluded by construction rather than by
   * a list somebody has to keep up to date.
   */
  @IsOptional()
  @IsBoolean()
  unlimitedPackageEligible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
