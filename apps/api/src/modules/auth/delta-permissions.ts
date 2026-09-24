import { ForbiddenException } from '@nestjs/common';
import type { AdminPermission } from '@prisma/client';
import { hasPermission } from './admin-permissions';
import type { AuthUser } from './auth.types';
import { INSUFFICIENT_PERMISSION } from './permissions.guard';

/**
 * What an edit request would actually change, split by the capability each
 * part needs. Both flags describe a *delta* against the stored record read
 * inside the same transaction. A value sent back unchanged is not a change.
 */
export type EditDelta = {
  /** Some business field would get a new value. */
  business: boolean;
  /** The status would get a new value. */
  status: boolean;
};

/**
 * The second half of `@RequiresAnyPermission` (BUG-RBAC-STATUS-001).
 *
 * - business delta only ⇒ `write`;
 * - status delta only ⇒ `status`;
 * - both ⇒ both (the guard is conjunctive here, as everywhere else);
 * - neither ⇒ nothing more. The guard has already admitted a holder of one of
 *   the two, and a request that changes nothing exercises neither capability.
 *
 * A SUPER_ADMIN holds every permission implicitly (`hasPermission`).
 */
export function assertDeltaPermissions(
  user: Pick<AuthUser, 'role' | 'permissions'>,
  delta: EditDelta,
  permissions: { write: AdminPermission; status: AdminPermission },
): void {
  const required: AdminPermission[] = [];
  if (delta.business) required.push(permissions.write);
  if (delta.status) required.push(permissions.status);
  if (required.length === 0) return;

  if (!hasPermission({ role: user.role, permissions: user.permissions ?? [] }, required)) {
    // Same body as PermissionsGuard's refusal: the missing permission is not
    // named, and the panel routes on the code.
    throw new ForbiddenException({
      code: INSUFFICIENT_PERMISSION,
      message: 'Insufficient permission',
    });
  }
}
