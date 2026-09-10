import { Equals, IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Accepting the price-responsibility text for one card.
 *
 * The same shape as `SubmitShowcaseCardDto`'s two fields, and deliberately not
 * shared with it. That one accepts terms as part of sending a card to review;
 * this one accepts them as an act on its own. Merging the two would tie a legal
 * acceptance to a content submission, which is the entire thing this endpoint
 * exists to separate — and a change to either would silently become a change to
 * the other.
 *
 * `@Equals(true)` rather than `@IsBoolean()` alone: a body carrying `false` is
 * not a smaller acceptance, it is the absence of one, and it is refused at the
 * DTO layer so no service ever has to decide what an unaccepted acceptance
 * means.
 *
 * `priceTermsVersion` is sent by the client and compared for equality against
 * the version in force. A mismatch is refused rather than coerced: a browser
 * showing a stale page would otherwise record an acceptance of a sentence the
 * person never read.
 */
export class AcceptShowcasePriceTermsDto {
  @IsBoolean()
  @Equals(true)
  priceTermsAccepted!: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  priceTermsVersion!: string;
}
