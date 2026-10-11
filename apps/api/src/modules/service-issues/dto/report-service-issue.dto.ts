import { ServiceIssueReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * `POST /service-requests/:id/service-issue` (REL-002 Faz 3).
 *
 * No date of any kind: the server's clock and the accepted offer's promised
 * days decide eligibility. A body carrying anything else is refused by the
 * global `forbidNonWhitelisted` pipe.
 */
export class ReportServiceIssueDto {
  /** The round the customer was looking at — a stale screen is refused, not redirected. */
  @IsString()
  @MaxLength(64)
  roundId!: string;

  @IsEnum(ServiceIssueReason)
  reason!: ServiceIssueReason;

  /** Required (>= 20 after trimming) for OTHER and PROVIDER_CANCELLED_BEFORE_START. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  /** Generated when the form opens; a retried submission with it is the same report. */
  @IsUUID()
  idempotencyKey!: string;
}
