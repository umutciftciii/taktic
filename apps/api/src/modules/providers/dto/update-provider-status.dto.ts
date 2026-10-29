import { ProviderStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateProviderStatusDto {
  @IsEnum(ProviderStatus)
  status!: ProviderStatus;

  /** The operator's internal note for this move. Never carried over from the last one. */
  @IsOptional()
  @IsString()
  moderationNote?: string | null;

  /** Required when `status` is REJECTED. Operator-only (PROVIDER-STATUS-001). */
  @IsOptional()
  @IsString()
  rejectionReason?: string | null;

  /** Required when `status` is SUSPENDED. Operator-only (PROVIDER-STATUS-001). */
  @IsOptional()
  @IsString()
  suspensionReason?: string | null;
}
