import { IsBoolean } from 'class-validator';

export class UpdateCreditPackageStatusDto {
  @IsBoolean()
  isActive!: boolean;
}
