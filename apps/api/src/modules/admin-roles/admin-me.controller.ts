import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { describePermissions } from '../auth/admin-permissions';

/**
 * What this session may do — the single source every admin surface reads
 * (design D13).
 *
 * The route guard, the sidebar, a list column, a detail block and an action
 * button all answer from this one response, which is what makes a hidden
 * button and a refused request two views of one fact instead of two rules that
 * drift apart. A screen that hides something the API would allow is a bug here,
 * and so is a screen that offers something the API refuses.
 *
 * It needs no permission of its own: `AdminAccessGuard` establishes that the
 * caller is staff with at least one live assignment, and what it returns is
 * that caller's own capabilities. A super admin gets the catalogue expanded
 * rather than a flag, so a client that reads only `permissions` is still right.
 */
@Controller('admin/me')
@UseGuards(AuthGuard, AdminAccessGuard)
export class AdminMeController {
  @Get('permissions')
  permissions(@CurrentUser() user: AuthUser) {
    return describePermissions({ role: user.role, permissions: user.permissions ?? [] });
  }
}
