import { AdminPermission } from '@prisma/client';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';

export const ADMIN_ROLE_KEY_MAX_LENGTH = 64;
export const ADMIN_ROLE_NAME_MAX_LENGTH = 120;
export const ADMIN_ROLE_DESCRIPTION_MAX_LENGTH = 500;

/**
 * A role is created with a key it keeps forever and a name an operator may
 * change. The key is lower-case kebab: it appears in audit rows and in the
 * panel's URLs, and a slug that may contain anything is a slug nobody can read
 * back.
 */
export class CreateAdminRoleDto {
  @IsString()
  @MinLength(2)
  @MaxCodeUnitLength(ADMIN_ROLE_KEY_MAX_LENGTH)
  @Matches(/^[a-z][a-z0-9-]*$/, {
    message: 'Rol anahtarı küçük harf, rakam ve tire içerebilir ve harfle başlamalıdır.',
  })
  key!: string;

  @IsString()
  @MinLength(2)
  @MaxCodeUnitLength(ADMIN_ROLE_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(ADMIN_ROLE_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  /**
   * The permissions the role is born with. Optional, and an empty set is a
   * legitimate role: a role that grants nothing still cannot reach the panel,
   * so it is a harmless placeholder rather than a trap.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsEnum(AdminPermission, { each: true })
  permissions?: AdminPermission[];
}

/** The name, the description and whether the role is live. Never the key. */
export class UpdateAdminRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxCodeUnitLength(ADMIN_ROLE_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(ADMIN_ROLE_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * The whole permission set, replacing whatever was there.
 *
 * Replacement rather than add/remove on purpose: two operators editing the same
 * role from two screens would otherwise interleave into a set neither of them
 * chose, and the audit row could not say what the role now holds without
 * replaying every earlier one.
 */
export class ReplaceAdminRolePermissionsDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsEnum(AdminPermission, { each: true })
  permissions!: AdminPermission[];
}

export class AssignAdminRoleDto {
  @IsString()
  @MinLength(1)
  roleId!: string;
}
