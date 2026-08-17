import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';
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
   * Mandatory on create: a category must never come into existence without a
   * price, otherwise it silently cannot receive offers. @Min(1) rejects 0 and
   * negatives, @IsInt rejects non-numeric and fractional input.
   */
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

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
