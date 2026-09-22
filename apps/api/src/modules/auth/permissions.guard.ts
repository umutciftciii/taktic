import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminPermission } from '@prisma/client';
import { hasPermission, isStaff } from './admin-permissions';
import type { AuthUser } from './auth.types';
import { REQUIRED_PERMISSIONS_KEY, STAFF_PERMISSIONS_KEY } from './permissions.decorator';

/**
 * The lock on a single admin capability.
 *
 * Reads what `@RequiresPermission(...)` put on the handler (or its controller)
 * and asks `admin-permissions.ts` — the same function `GET /admin/me/permissions`
 * answers from, which is what makes a hidden button and a refused request two
 * views of one fact rather than two rules that drift.
 *
 * A handler with no metadata is let through: this guard says nothing about
 * routes that do not name a permission, and `AdminAccessGuard` is what keeps
 * those from being public. The two are always used together.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser | null | undefined;

    const required = this.reflector.getAllAndOverride<AdminPermission[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      // A route that only asks something of staff callers: a provider editing
      // their own record passes through untouched, and the service's ownership
      // rules — which this guard never replaces — still decide.
      const fromStaff = this.reflector.getAllAndOverride<AdminPermission[]>(STAFF_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

      if (!fromStaff || fromStaff.length === 0 || !isStaff(user ? { role: user.role } : null)) {
        return true;
      }

      if (!hasPermission({ role: user!.role, permissions: user!.permissions ?? [] }, fromStaff)) {
        throw new ForbiddenException('Insufficient permission');
      }

      return true;
    }

    if (!hasPermission(user ? { role: user.role, permissions: user.permissions ?? [] } : null, required)) {
      // The missing permission is deliberately not named: a refusal that lists
      // what the caller lacks is a map of the panel for anyone probing it.
      throw new ForbiddenException('Insufficient permission');
    }

    return true;
  }
}
