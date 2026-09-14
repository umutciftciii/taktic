import { ServiceRequestReportReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { REPORT_NOTE_MAX_LENGTH } from '../request-reports.constants';

export class CreateRequestReportDto {
  @IsEnum(ServiceRequestReportReason)
  reason!: ServiceRequestReportReason;

  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(REPORT_NOTE_MAX_LENGTH)
  note?: string | null;
}
