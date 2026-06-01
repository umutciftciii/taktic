import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateOfferDto {
  // priceAmount is stored in the currency's minor unit (kuruş for TRY).
  // Provider UI accepts a decimal like "1500,00" and the server action converts
  // it to minor units before reaching this DTO. Minimum 100 = 1,00 TRY.
  @IsInt()
  @Min(100)
  priceAmount!: number;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsString()
  estimatedStartDate?: string | null;

  @IsOptional()
  @IsString()
  estimatedCompletionDate?: string | null;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  warrantyNote?: string | null;

  @IsOptional()
  @IsString()
  internalNote?: string | null;
}
