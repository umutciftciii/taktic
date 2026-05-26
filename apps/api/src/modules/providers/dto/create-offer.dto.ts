import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateOfferDto {
  @IsInt()
  @Min(1)
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
