import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class RefundOfferCreditDto {
  @IsString()
  reasonCode!: string;

  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsBoolean()
  override?: boolean;
}
