import {
  IsBoolean,
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
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
