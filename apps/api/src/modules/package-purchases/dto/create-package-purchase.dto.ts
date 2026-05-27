import { IsOptional, IsString } from 'class-validator';

export class CreatePackagePurchaseDto {
  @IsString()
  packageId!: string;

  @IsOptional()
  @IsString()
  providerNote?: string | null;
}
