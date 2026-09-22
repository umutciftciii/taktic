import { AdminPermission, UserRole } from '@prisma/client';

export type AuthUser = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: UserRole;
  isActive: boolean;
  /**
   * When the account proved its own `phone` (see User.phoneVerifiedAt).
   * Present on the session's own user; optional so callers that build an
   * AuthUser from a narrower read are not forced to carry it.
   */
  phoneVerifiedAt?: Date | null;
  /** When the account proved its own `email` (see User.emailVerifiedAt). Same terms. */
  emailVerifiedAt?: Date | null;
  /**
   * The admin capabilities this session carries, resolved from the account's
   * *live* assignments to *active* roles (PR-0).
   *
   * Empty for a customer, a provider, a staff account nobody has given a role
   * to — and for a SUPER_ADMIN, which needs none: `hasPermission` answers true
   * for it whatever this list says. Never read directly to decide anything;
   * `admin-permissions.ts` is the one place that interprets it, so a screen and
   * a route cannot reach different conclusions from the same session.
   *
   * Optional for the same reason `phoneVerifiedAt` is: callers that build an
   * AuthUser from a narrower read are not forced to carry it. A missing list
   * reads as "no permissions", which is the safe answer.
   */
  permissions?: AdminPermission[];
};
