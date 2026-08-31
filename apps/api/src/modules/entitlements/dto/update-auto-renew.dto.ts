import { IsBoolean } from 'class-validator';

export class UpdateAutoRenewDto {
  @IsBoolean()
  enabled!: boolean;
}
