import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isStaff, mayReachAdminPanel } from './admin-permissions';
import type { AuthUser } from './auth.types';

/**
 * Two refusals that look the same over HTTP and are not the same thing.
 *
 * `NOT_STAFF` is a customer's or a provider's session asking for an admin
 * screen: they are signed in as the wrong kind of account, and the answer is
 * the sign-in form. `ADMIN_ACCESS_DENIED` is a staff account nobody has given a
 * role to — signing in again changes nothing, so the answer is a page that says
 * what is missing.
 *
 * Neither code tells the caller anything it did not already know about its own
 * session; what they let the panel do is stop sending the second case to a
 * login form it is already past.
 */
export const NOT_STAFF = 'NOT_STAFF';
export const ADMIN_ACCESS_DENIED = 'ADMIN_ACCESS_DENIED';

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

    const principal = user ? { role: user.role, permissions: user.permissions ?? [] } : null;

    if (!isStaff(principal)) {
      throw new ForbiddenException({ code: NOT_STAFF, message: 'Admin access denied' });
    }

    if (!mayReachAdminPanel(principal)) {
      throw new ForbiddenException({ code: ADMIN_ACCESS_DENIED, message: 'Admin access denied' });
    }

    return true;
  }
}
