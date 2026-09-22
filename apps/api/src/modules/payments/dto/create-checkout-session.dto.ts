import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Everything a provider is allowed to say about a checkout.
 *
 * Which package, and an optional note for their own records. There is
 * deliberately no credit amount, no price, no currency and no provider id in
 * the body: all four are resolved server-side from the active credit package
 * and snapshotted onto the purchase, so a tampered request buys the same thing
 * for the same money as an honest one.
 */
export class CreateCheckoutSessionDto {
  @IsString()
  packageId!: string;

  @IsOptional()
  @IsString()
  providerNote?: string | null;

  /**
   * CMP-006 PR-A. Read only while the purchase-terms gate is open: a literal
   * `true` from the separate, unticked-by-default consent box, and the version
   * of the text the screen showed. With the gate closed both are ignored.
   */
  @IsOptional()
  @IsBoolean()
  termsAccepted?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  termsVersion?: string;
}
