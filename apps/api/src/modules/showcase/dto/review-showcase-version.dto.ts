import { ShowcaseCardStatus, ShowcaseVersionReview } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SHOWCASE_REVIEW_NOTE_MAX_LENGTH } from '../showcase.constants';

/**
 * An operator's rejection, and the reason that has to come with it.
 *
 * The note is required and has a floor, because the provider reads it: a
 * rejection they cannot act on is not a review, and "hayır" is not a reason.
 * The database says the same thing — `ShowcaseCardReview_note_matches_decision`
 * refuses a REJECTED row with no note — so a future code path cannot file a
 * silent refusal.
 */
export class RejectShowcaseVersionDto {
  @IsString()
  @MinLength(10)
  @MaxLength(SHOWCASE_REVIEW_NOTE_MAX_LENGTH)
  note!: string;
}

/** Filters for the operator's version queue. */
export class ListShowcaseVersionsDto {
  @IsOptional()
  @IsEnum(ShowcaseVersionReview)
  reviewStatus?: ShowcaseVersionReview;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerId?: string;
}

/** Filters for the operator's card list. */
export class ListShowcaseCardsDto {
  @IsOptional()
  @IsEnum(ShowcaseCardStatus)
  status?: ShowcaseCardStatus;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerId?: string;
}

/**
 * The note an operator leaves when pulling a card.
 *
 * Optional and free text, and it is the only field. There is deliberately no
 * `reason` code: an operator's pull is `ADMIN_ACTION` by definition, and a body
 * that could name a different reason could name one that does not stop the
 * paid clock.
 *
 * The note is stored on the card rather than sent anywhere. Telling a provider
 * their card was pulled is a product decision with its own message; a free-text
 * field routed straight into somebody's inbox is not that decision being made
 * carefully.
 */
export class SuspendShowcaseCardDto {
  @IsOptional()
  @IsString()
  @MaxLength(SHOWCASE_REVIEW_NOTE_MAX_LENGTH)
  note?: string;
}
