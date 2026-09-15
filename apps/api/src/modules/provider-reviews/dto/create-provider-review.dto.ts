import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { PROVIDER_REVIEW_COMMENT_MAX_LENGTH } from '../../../common/provider-review-limits';

/**
 * Only the rating and the optional comment. The request, the offer, the
 * provider and the reviewer are all derived server-side; the global pipe's
 * `forbidNonWhitelisted` refuses any id smuggled into the body.
 */
export class CreateProviderReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(PROVIDER_REVIEW_COMMENT_MAX_LENGTH)
  comment?: string | null;
}
