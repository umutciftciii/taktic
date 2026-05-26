import { IsString } from 'class-validator';

export class RefundOfferCreditDto {
  @IsString()
  reason!: string;
}
