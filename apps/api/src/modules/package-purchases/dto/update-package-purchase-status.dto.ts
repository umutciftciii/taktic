import { PackagePurchaseStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdatePackagePurchaseStatusDto {
  @IsEnum(PackagePurchaseStatus)
  status!: PackagePurchaseStatus;

  @IsOptional()
  @IsString()
  adminNote?: string | null;
}
