import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsKnownTurkishLocation } from '../../locations/turkish-location.validator';

/**
 * What a customer may change about their own account.
 *
 * The absent field is the point of this DTO. `email` is not declared, and the
 * global ValidationPipe runs with `forbidNonWhitelisted`, so a body carrying
 * one is refused outright rather than quietly ignored — the address stays
 * read-only this round, and "read-only" is enforced by the shape of the
 * request rather than by a service remembering not to copy it.
 */
export class UpdateAccountProfileDto {
  /**
   * Trimmed before it is measured, so a name of spaces is the empty name it
   * really is. Two characters is the floor UsersService.create already applies
   * to an operator-created account; one spelling of "a name" for the platform.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /**
   * Required, and required to be a real number: the account's telephone is
   * what a service request is answered on, and the request flow refuses to
   * create one without it. The format itself is decided by
   * `normalizePhoneNumber` in the service — the same function the one-time
   * code path already validates against, so there is no second, looser idea of
   * what a telephone number is.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  phone!: string;

  /**
   * Optional, and clearable: an empty string is an explicit "I no longer want
   * this on file" and is stored as NULL. Nothing in the product requires it,
   * so refusing to clear it would be inventing a requirement.
   *
   * When there is a value it has to name a real province. The check is the one
   * every other city field in the product carries, which is what keeps the
   * stored spelling comparable with a request's city and a provider's service
   * area; the constraint passes an empty value through to `@IsOptional` above.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @IsKnownTurkishLocation()
  city?: string | null;
}
