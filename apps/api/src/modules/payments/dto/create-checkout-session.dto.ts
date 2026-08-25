import { IsOptional, IsString } from 'class-validator';

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
}
