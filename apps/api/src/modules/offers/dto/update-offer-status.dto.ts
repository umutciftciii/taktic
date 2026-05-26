import { OfferStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateOfferStatusDto {
  @IsEnum(OfferStatus)
  status!: OfferStatus;
}
