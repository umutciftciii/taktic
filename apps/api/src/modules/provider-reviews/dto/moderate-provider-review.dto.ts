import { ProviderReviewModerationAction, ProviderReviewReportReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { REVIEW_MODERATION_NOTE_MAX_LENGTH } from '../provider-reviews.constants';

export class ModerateProviderReviewDto {
  @IsEnum(ProviderReviewModerationAction)
  action!: ProviderReviewModerationAction;

  /**
   * Required exactly when something is removed: it is the one thing the
   * customer is told, so a removal without it has nothing to say. Ignored on
   * RESTORE, where the database's CHECK insists it is NULL.
   */
  @ValidateIf(
    (dto: ModerateProviderReviewDto) => dto.action !== ProviderReviewModerationAction.RESTORE,
  )
  @IsEnum(ProviderReviewReportReason, { message: 'Kaldırmak için gerekçe seçilmelidir.' })
  reason?: ProviderReviewReportReason;

  /** Operator-only; copied onto the reports this decision closes. */
  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(REVIEW_MODERATION_NOTE_MAX_LENGTH)
  note?: string | null;
}
