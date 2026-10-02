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

  /**
   * Compare-and-set: the status the caller decided against. When given, the
   * save is refused with 409 REQUEST_STATUS_CHANGED — nothing written, no
   * fan-out booked — unless the request still has exactly this status inside
   * the save's transaction. The admin panel sends it on "İncelemeye al", whose
   * confirmation depends on whether the request was live (APPROVED) or new
   * (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2).
   */
  @IsOptional()
  @IsEnum(ServiceRequestStatus)
  expectedCurrentStatus?: ServiceRequestStatus;
}
