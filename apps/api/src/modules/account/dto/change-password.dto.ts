import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The same bounds ConfirmPasswordResetDto and SubmitCustomerActivationDto use.
 *
 * The marketplace's password policy is a length range and nothing else, and a
 * third spelling of it here would let the screen that changes a password
 * disagree with the two that set one. A staff account's new password is judged
 * again, by the stricter staff rule (common/staff-password-policy.ts,
 * ADMIN-AUTH-002), in AccountService.changePassword.
 *
 * `currentPassword` and `newPasswordConfirm` carry no policy of their own on
 * purpose. The first is measured against the stored hash, not against a rule,
 * and the second only has to equal `newPassword`; giving either its own length
 * bound would refuse a legitimate submission with the wrong sentence.
 */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;

  @IsString()
  @IsNotEmpty()
  newPasswordConfirm!: string;
}
