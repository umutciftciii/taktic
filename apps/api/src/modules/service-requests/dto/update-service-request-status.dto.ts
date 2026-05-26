import { ServiceRequestStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateServiceRequestStatusDto {
  @IsEnum(ServiceRequestStatus)
  status!: ServiceRequestStatus;
}
