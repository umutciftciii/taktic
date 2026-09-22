import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { mayReachAdminPanel } from './admin-permissions';
import type { AuthUser } from './auth.types';

/**
 * The door to the admin panel, enforced by the API rather than by a screen.
 *
 * A SUPER_ADMIN passes. An ADMIN passes once it holds at least one permission —
 * that is, at least one live assignment to an active role. Everyone else is
 * refused, including a customer or a provider who somehow acquired an
 * assignment: `mayReachAdminPanel` checks the account kind as well as the list.
 *
 * Why the door is separate from the locks. `PermissionsGuard` answers "may this
 * account do X"; this answers "is this account staff at all". Without it, a
 * route that happens to need no permission — `GET /admin/me/permissions` — would
 * be open to every signed-in customer, and an ADMIN whose last role was revoked
 * would keep reaching pages that ask for nothing in particular. The two
 * questions have different answers and each needs its own guard.
 *
 * Ordering: always after AuthGuard, which is what puts `request.user` there.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser | null | undefined;

    if (!mayReachAdminPanel(user ? { role: user.role, permissions: user.permissions ?? [] } : null)) {
      throw new ForbiddenException('Admin access denied');
    }

    return true;
  }
}
