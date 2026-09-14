import { ServiceRequestReportResolution } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { REMOVAL_REASON_KEYS, RemovalReasonKey } from '../request-report-copy';
import { REPORT_NOTE_MAX_LENGTH } from '../request-reports.constants';

export class ResolveRequestReportsDto {
  @IsEnum(ServiceRequestReportResolution)
  resolution!: ServiceRequestReportResolution;

  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(REPORT_NOTE_MAX_LENGTH)
  resolutionNote?: string | null;

  /**
   * Required exactly when the decision removes the request: it is the one
   * thing the customer is told, so a removal without it has nothing to say.
   */
  @ValidateIf(
    (dto: ResolveRequestReportsDto) =>
      dto.resolution === ServiceRequestReportResolution.REQUEST_REMOVED,
  )
  @IsIn(REMOVAL_REASON_KEYS, { message: 'Talebi kaldırmak için gerekçe seçilmelidir.' })
  removalReason?: RemovalReasonKey;
}

export class ReopenRequestDto {
  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(REPORT_NOTE_MAX_LENGTH)
  moderationNote?: string | null;
}
