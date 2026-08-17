import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateOfferDto {
  // priceAmount is stored in the currency's minor unit (kuruş for TRY).
  // Provider UI accepts a decimal like "1500,00" and the server action converts
  // it to minor units before reaching this DTO. Minimum 100 = 1,00 TRY.
  @IsInt()
  @Min(100)
  priceAmount!: number;

  /**
   * The credit cost the provider was shown when the form was rendered.
   *
   * Optional, and it is only ever compared for equality against the live
   * category price inside the offer transaction — it never determines what is
   * charged. A mismatch means the price changed while the form was open, and
   * the request is rejected with 409 CREDIT_COST_CHANGED so nothing is billed
   * at a price the provider never saw.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedCreditCost?: number;

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
