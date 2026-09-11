import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * "Use one of my rights on this card." Which one is optional: omitted, the
 * earliest-expiring usable right of the card's kind is taken, which is what a
 * provider holding two packages expects to be spent first.
 */
export class UseShowcaseEntitlementDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entitlementId?: string;
}
