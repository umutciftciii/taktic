import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePackagePurchaseDto {
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
