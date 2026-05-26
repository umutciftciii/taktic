import { ServiceRequestStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateServiceRequestStatusDto {
  @IsEnum(ServiceRequestStatus)
  status!: ServiceRequestStatus;

  @IsOptional()
  @IsString()
  moderationNote?: string | null;

  @IsOptional()
  @IsString()
  rejectionReason?: string | null;
}
