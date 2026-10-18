import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * The password carries no length bound here on purpose: every invite is for a
 * staff account, and the staff rule (common/staff-password-policy.ts,
 * ADMIN-AUTH-002) is judged in AdminInviteService.submit, which answers with the
 * rule's own sentence and code. A DTO bound would refuse a short password with
 * a generic validator message before the panel's wording ever reached it.
 */
export class SubmitAdminInviteDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
