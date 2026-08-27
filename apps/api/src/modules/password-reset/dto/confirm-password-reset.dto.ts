import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The same bounds SubmitCustomerActivationDto uses. There is one password
 * policy in this product — a length range, and nothing else — and a second
 * spelling of it here would let the two screens disagree about what is
 * acceptable.
 */
export class ConfirmPasswordResetDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
