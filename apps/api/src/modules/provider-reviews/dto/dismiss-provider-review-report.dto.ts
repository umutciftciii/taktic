import { IsOptional, IsString } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { REVIEW_MODERATION_NOTE_MAX_LENGTH } from '../provider-reviews.constants';

export class DismissProviderReviewReportDto {
  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(REVIEW_MODERATION_NOTE_MAX_LENGTH)
  resolutionNote?: string | null;
}
