import { IsBoolean } from 'class-validator';

export class UpdateCustomerStatusDto {
  @IsBoolean()
  isActive!: boolean;
}
