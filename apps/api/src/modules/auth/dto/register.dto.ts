import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  name!: string;

  /**
   * Trimmed before it is validated, not after.
   *
   * `@IsEmail` rejects surrounding whitespace, so a padded address used to come
   * back as "email must be an email" — a 400 that told a visitor their address
   * was malformed when the real answer was that it belongs to another kind of
   * account. Folding the padding away here means the address reaches the
   * service in the same form the address it collides with is stored in, and the
   * refusal is the one the rule actually has.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  phone?: string | null;
}
