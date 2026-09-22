import { SetMetadata } from '@nestjs/common';
import type { AdminPermission } from '@prisma/client';

export const REQUIRED_PERMISSIONS_KEY = 'requiredAdminPermissions';

/**
 * The permissions a handler needs, as values of the closed catalogue.
 *
 * Typed against the Prisma enum on purpose: a permission name that is not in
 * `AdminPermission` does not compile, so a route cannot be guarded by a
 * capability no role can ever be given. That is the compile-time half of the
 * rule whose database half is the enum itself — `AdminRolePermission` cannot
 * store a literal the type does not contain.
 *
 * Several permissions mean *all* of them (see `hasPermission`).
 */
export const RequiresPermission = (...permissions: AdminPermission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export const STAFF_PERMISSIONS_KEY = 'requiredAdminPermissionsFromStaff';

/**
 * The permissions a handler needs **of a staff caller**, on a route that is not
 * an admin route.
 *
 * A handful of endpoints serve two audiences at once: the owner of a record and
 * an operator looking at it. `PATCH /providers/:id` is the one such route in
 * PR-0 — a provider edits their own profile through it, and an operator
 * corrects a typo through the same handler, with the service deciding which of
 * the two is talking (`ensureProviderUpdateAccess`).
 *
 * `@RequiresPermission` cannot express that: it refuses every non-staff caller,
 * which would take the route away from the providers it primarily belongs to.
 * This decorator says the narrower thing that is actually true — *if* the
 * caller is staff, they need this capability; if they are not, this guard has
 * no opinion and the service's own ownership rules decide, exactly as before.
 *
 * It is deliberately not a general-purpose escape hatch. A route that only
 * operators call must use `@RequiresPermission`, because "no opinion about
 * non-staff callers" is the wrong answer when there are none.
 */
export const RequiresPermissionFromStaff = (...permissions: AdminPermission[]) =>
  SetMetadata(STAFF_PERMISSIONS_KEY, permissions);
