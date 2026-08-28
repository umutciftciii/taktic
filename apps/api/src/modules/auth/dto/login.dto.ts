import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  /**
   * "Beni hatırla".
   *
   * Optional, and absent means false: a client that says nothing gets the
   * shorter, non-persistent session rather than the longer one. Accepts the
   * string "true"/"false" as well as a real boolean, because an HTML form posts
   * strings and this endpoint is reached from one.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
  @IsBoolean()
  rememberMe?: boolean;
}
