import { IsIn } from 'class-validator';

export class CustomerOfferActionDto {
  @IsIn(['SHORTLIST', 'REJECT', 'ACCEPT'])
  action!: 'SHORTLIST' | 'REJECT' | 'ACCEPT';
}
