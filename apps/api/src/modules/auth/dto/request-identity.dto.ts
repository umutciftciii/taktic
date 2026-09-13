import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * The pair the request form asks about. Both are mandatory on purpose: the
 * answer is about the *pair* (two fields pointing at two accounts is its own
 * state), and a single-field lookup would be a plain "is this registered"
 * oracle.
 */
export class RequestIdentityCheckDto {
  @IsString()
  @MinLength(7)
  @MaxLength(20)
  phone!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  email!: string;
}

export class RequestIdentityActivateDto extends RequestIdentityCheckDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  redirectTo?: string;
}
