import { AdminPermission, UserRole } from '@prisma/client';

/**
 * Who may act in the admin panel, and with what.
 *
 * Two questions, deliberately separate, and this file answers both from one
 * place so a screen and a route can never disagree (design D13):
 *
 *   mayReachAdminPanel  — is this account staff at all?
 *   hasPermission       — may it do this particular thing?
 *
 * The rules, in full:
 *
 *   SUPER_ADMIN  every permission, with or without an assignment. It is the
 *                bootstrap account and the holder of the three root
 *                capabilities that are not in `AdminPermission` at all
 *                (defining roles, creating staff accounts, minting their
 *                invite links) — those stay on `@Roles(UserRole.SUPER_ADMIN)`
 *                and cannot be delegated, because no role row can carry a
 *                value the enum does not contain.
 *
 *   ADMIN        exactly the union of the permissions of its *live*
 *                assignments to *active* roles. An ADMIN with none may sign in
 *                but cannot reach the panel: a staff account that has not been
 *                given anything has not been given the panel either.
 *
 *   CUSTOMER /   never, whatever they hold. An assignment on such an account
 *   PROVIDER     would be a bug, and this function refuses to read it rather
 *                than trusting that one cannot exist.
 */

/** The account kinds that are staff. Never a capability — see UserRole.ADMIN. */
export const STAFF_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN, UserRole.ADMIN];

export type PermissionPrincipal = {
  role: UserRole;
  /** Resolved from live assignments; empty for a SUPER_ADMIN, which needs none. */
  permissions: readonly AdminPermission[];
};

export function isSuperAdmin(user: Pick<PermissionPrincipal, 'role'> | null | undefined): boolean {
  return user?.role === UserRole.SUPER_ADMIN;
}

export function isStaff(user: Pick<PermissionPrincipal, 'role'> | null | undefined): boolean {
  return user !== null && user !== undefined && STAFF_ROLES.includes(user.role);
}

/**
 * Whether this principal may open the admin panel at all.
 *
 * A SUPER_ADMIN always may. An ADMIN may once it holds at least one permission,
 * which is the same thing as holding at least one live assignment to an active
 * role — the resolver returns nothing for an inactive role or a revoked
 * assignment, so "has permissions" and "has access" cannot drift apart.
 */
export function mayReachAdminPanel(user: PermissionPrincipal | null | undefined): boolean {
  if (!user) {
    return false;
  }
  if (isSuperAdmin(user)) {
    return true;
  }
  return user.role === UserRole.ADMIN && user.permissions.length > 0;
}

/**
 * Whether this principal holds every one of the required permissions.
 *
 * Conjunctive on purpose: a route that names two permissions needs both. No
 * route in PR-0 names more than one, but the guard accepts a list and the
 * meaning has to be fixed before one does.
 */
export function hasPermission(
  user: PermissionPrincipal | null | undefined,
  required: readonly AdminPermission[],
): boolean {
  if (!user || !isStaff(user)) {
    return false;
  }
  if (isSuperAdmin(user)) {
    return true;
  }
  if (required.length === 0) {
    return mayReachAdminPanel(user);
  }
  const held = new Set(user.permissions);
  return required.every((permission) => held.has(permission));
}

/**
 * What `GET /admin/me/permissions` answers — and the single source every
 * surface reads: the route guard, the sidebar, a list column, a detail block
 * and an action button.
 *
 * A SUPER_ADMIN is reported with the whole catalogue expanded rather than with
 * an empty list and a flag, so a client that only looks at `permissions` is
 * still correct. `isSuperAdmin` is carried as well, because the three root
 * capabilities have no permission value to expand into and a screen that offers
 * "roles" has to know.
 */
export function describePermissions(user: PermissionPrincipal): {
  role: UserRole;
  isSuperAdmin: boolean;
  permissions: AdminPermission[];
} {
  const superAdmin = isSuperAdmin(user);
  return {
    role: user.role,
    isSuperAdmin: superAdmin,
    permissions: superAdmin ? [...ALL_ADMIN_PERMISSIONS] : [...user.permissions].sort(),
  };
}

/** Every value of the catalogue, sorted, derived from the enum itself. */
export const ALL_ADMIN_PERMISSIONS: readonly AdminPermission[] = Object.values(
  AdminPermission,
).sort() as AdminPermission[];
