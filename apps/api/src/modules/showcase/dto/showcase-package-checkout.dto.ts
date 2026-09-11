import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
}
