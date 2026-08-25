import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SubmitProviderClaimDto {
  @IsString()
  @MinLength(1)
  token!: string;

  /**
   * Optional because only one of the two outcomes needs it.
   *
   * A claim that creates an account has to set a password; a claim that links
   * the application to the provider account already signed in must not be able
   * to change that account's password by passing one. The service decides which
   * case it is and refuses a missing password with PASSWORD_REQUIRED rather
   * than letting the DTO make a rule it cannot see the context for.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;
}
