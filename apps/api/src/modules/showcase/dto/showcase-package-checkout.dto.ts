import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import {
  SHOWCASE_PACKAGE_MAX_FREE_OFFER_COUNT,
  SHOWCASE_PACKAGE_MIN_FREE_OFFER_COUNT,
} from '../showcase.constants';

/**
 * What a provider names when they buy a publication right: a package from the
 * catalogue, and — the first time under any given version of the terms — their
 * agreement to the price-responsibility text.
 *
 * There is no card and no version here, and that is the design of the
 * package-first sale: the money buys a right, and the right is spent when a
 * card is approved later. Price, duration and currency are read server-side
 * from the package, so a body cannot decide what a right costs.
 */
export class CreateShowcasePackageCheckoutDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  showcasePackageId!: string;

  /**
   * Both optional: a provider whose acceptance of the version in force is
   * already on file sends neither. When there is no acceptance, both are
   * required and checked by the service — an omitted checkbox is a refusal.
   */
  @IsOptional()
  @IsBoolean()
  priceTermsAccepted?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  priceTermsVersion?: string;

  /**
   * SHOWCASE-ALLOWANCE-001 — the free offer count the buying screen showed.
   * Optional for older clients; when sent, a package edited since the screen
   * was rendered refuses with 409 SHOWCASE_PACKAGE_FREE_OFFERS_CHANGED instead
   * of selling a different number than the one promised.
   */
  // Omitted is allowed; null is not a count, so it is refused rather than
  // read as "omitted" the way `@IsOptional` would.
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(SHOWCASE_PACKAGE_MIN_FREE_OFFER_COUNT)
  @Max(SHOWCASE_PACKAGE_MAX_FREE_OFFER_COUNT)
  expectedFreeOfferCount?: number;
}
