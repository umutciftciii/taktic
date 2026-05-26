import { ProviderStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateProviderStatusDto {
  @IsEnum(ProviderStatus)
  status!: ProviderStatus;

  @IsOptional()
  @IsString()
  moderationNote?: string | null;

  @IsOptional()
  @IsString()
  rejectionReason?: string | null;
}
