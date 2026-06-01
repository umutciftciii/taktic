import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

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
  @Min(1)
  creditAmount?: number;

  // priceAmount is stored in the currency's minor unit. Minimum 100 = 1,00 TRY.
  @IsOptional()
  @IsInt()
  @Min(100)
  priceAmount?: number;

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
