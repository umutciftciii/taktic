import { Equals, IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The provider's acceptance of the price-responsibility text, sent with the
 * submission it belongs to.
 *
 * `@Equals(true)` rather than a plain boolean: an omitted or false flag is a
 * submission without acceptance, and the only correct answer to that is a
 * refusal. Nothing in this endpoint defaults it.
 *
 * `priceTermsVersion` is sent by the client and checked for equality against the
 * version this build ships — never trusted as the value to store. It is there so
 * a provider whose page was loaded before a text change cannot accept a screen
 * they are no longer looking at: their submission is refused and they are shown
 * the current text.
 */
export class SubmitShowcaseCardDto {
  @IsBoolean()
  @Equals(true)
  priceTermsAccepted!: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  priceTermsVersion!: string;
}
