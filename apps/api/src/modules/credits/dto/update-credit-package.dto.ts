import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

/**
 * A package's `type` is deliberately absent: it is not editable.
 *
 * Changing what a package sells after periods have been bought against it would
 * make every one of those entitlements describe a product that no longer
 * exists. Selling something different means a new package and deactivating the
 * old one, which leaves the history intact.
 */
export class UpdateCreditPackageDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  creditAmount?: number;

  // priceAmount is stored in the currency's minor unit. Minimum 100 = 1,00 TRY.
  @IsOptional()
  @IsInt()
  @Min(100)
  priceAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  quotaCredits?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  dailyOfferLimit?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopeCategoryIds?: string[];

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
