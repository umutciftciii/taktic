import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The same bounds SubmitCustomerActivationDto uses. The marketplace's password
 * policy is a length range and nothing else, and a second spelling of it here
 * would let the two screens disagree about what is acceptable.
 *
 * A staff account's link is judged again, by the stricter staff rule
 * (common/staff-password-policy.ts, ADMIN-AUTH-002), in
 * PasswordResetService.confirm — only the service knows whose link it is.
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
