import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';

export class CreateCreditPackageDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;

  @IsInt()
  @Min(1)
  creditAmount!: number;

  // priceAmount is stored in the currency's minor unit (e.g. kuruş for TRY).
  // Minimum 100 = 1 unit (1,00 TRY). Decimals must be converted to minor units
  // on the client/server-action side before reaching the API.
  @IsInt()
  @Min(100)
  priceAmount!: number;

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
