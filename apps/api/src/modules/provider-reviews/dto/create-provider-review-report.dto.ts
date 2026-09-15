import { ProviderReviewReportReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { REVIEW_REPORT_NOTE_MAX_LENGTH } from '../provider-reviews.constants';

/**
 * The reason and an optional note for the operator. The review and the
 * reporter come from the path and the guard; the note never leaves the
 * company.
 */
export class CreateProviderReviewReportDto {
  @IsEnum(ProviderReviewReportReason)
  reason!: ProviderReviewReportReason;

  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(REVIEW_REPORT_NOTE_MAX_LENGTH)
  note?: string | null;
}
