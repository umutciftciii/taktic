import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AdminRolesService } from './admin-roles.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import {
  AssignAdminRoleDto,
  CreateAdminRoleDto,
  ReplaceAdminRolePermissionsDto,
  UpdateAdminRoleDto,
} from './dto/admin-role.dto';

/**
 * Defining authority, which is deliberately not part of the authority it
 * defines.
 *
 * Every route here is `@Roles(UserRole.SUPER_ADMIN)` and **no permission value
 * guards any of them** — there is none to guard them with, because
 * `ADMIN_ROLES_MANAGE` is absent from the `AdminPermission` catalogue on
 * purpose (RG-7 §12.1). A role that could reach these routes could give itself
 * every other permission, and a permission model with that hole in it is not a
 * permission model. The same reasoning keeps `POST /users` and
 * `POST /users/:id/invite-link` on the role decorator.
 *
 * So: `RolesGuard` here, `PermissionsGuard` everywhere else, and the difference
 * between them is exactly the difference between root and delegable.
 */
@Controller('admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminRolesController {
  constructor(@Inject(AdminRolesService) private readonly roles: AdminRolesService) {}

  /** The closed catalogue the role builder ticks boxes from. */
  @Get('permissions')
  catalogue() {
    return this.roles.listCatalogue();
  }

  @Get('roles')
  list() {
    return this.roles.list();
  }

  @Post('roles')
  create(@Body() dto: CreateAdminRoleDto, @CurrentUser() user: AuthUser) {
    return this.roles.create(dto, requireActor(user));
  }

  @Get('roles/:id')
  detail(@Param('id') id: string) {
    return this.roles.detail(id);
  }

  @Patch('roles/:id')
  update(@Param('id') id: string, @Body() dto: UpdateAdminRoleDto, @CurrentUser() user: AuthUser) {
    return this.roles.update(id, dto, requireActor(user));
  }

  @Put('roles/:id/permissions')
  replacePermissions(
    @Param('id') id: string,
    @Body() dto: ReplaceAdminRolePermissionsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.roles.replacePermissions(id, dto, requireActor(user));
  }

  @Get('users/:userId/roles')
  listForUser(@Param('userId') userId: string) {
    return this.roles.listForUser(userId);
  }

  @Post('users/:userId/roles')
  assign(@Param('userId') userId: string, @Body() dto: AssignAdminRoleDto, @CurrentUser() user: AuthUser) {
    return this.roles.assign(userId, dto, requireActor(user));
  }

  @Delete('users/:userId/roles/:roleId')
  revoke(@Param('userId') userId: string, @Param('roleId') roleId: string, @CurrentUser() user: AuthUser) {
    return this.roles.revoke(userId, roleId, requireActor(user));
  }
}

/**
 * The actor is the session and nothing else. The guards above already make a
 * null user unreachable; this restates it where the audit row is written, since
 * every one of those rows has a NOT NULL actor and a change to somebody's
 * access with nobody's name on it is the thing that column exists to prevent.
 */
function requireActor(user: AuthUser | null): AuthUser {
  if (!user?.id) {
    throw new ForbiddenException('Authenticated operator required');
  }
  return user;
}
