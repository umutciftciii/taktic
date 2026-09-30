/**
 * The role screens' arithmetic (ADMIN-DESIGN-001 Faz 3G), with no import of
 * `lib/api` so the client matrix and its confirmation can use it too.
 *
 * Every figure is computed from data the page already read — the catalogue,
 * the role's permission set, its live assignments, an account's assignments —
 * and nothing is estimated. Where the data does not say something, these
 * functions do not say it either.
 */

export type PermissionGroupItem = { permission: string; action: string };
export type PermissionGroup = { area: string; items: PermissionGroupItem[] };

/** What saving `next` over `previous` would add and take away. */
export function diffPermissions(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: [...after].filter((permission) => !before.has(permission)).sort(),
    removed: [...before].filter((permission) => !after.has(permission)).sort(),
  };
}

/** permission → "Talepler · okuma", from the groups the page built. */
export function permissionLines(groups: readonly PermissionGroup[]): Map<string, string> {
  const lines = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) {
      lines.set(item.permission, `${group.area} · ${item.action}`);
    }
  }
  return lines;
}

/**
 * The accounts a change to a role reaches, from the role detail's own
 * assignment list (`GET /admin/roles/:id` returns the live assignments only —
 * `revokedAt: null` — each with its user's `isActive`). `holders` is that
 * list's length and `activeHolders` the ones that can sign in today.
 */
export function roleReach(assignments: readonly { user: { isActive: boolean } }[]): {
  holders: number;
  activeHolders: number;
} {
  return {
    holders: assignments.length,
    activeHolders: assignments.filter((assignment) => assignment.user.isActive).length,
  };
}

type HeldAssignment = {
  revokedAt: string | null;
  role: { id: string; isActive: boolean; permissions: readonly string[] };
};

/** The union of what an account's live, active roles grant — what its session reads. */
export function effectivePermissions(assignments: readonly HeldAssignment[]): string[] {
  return [
    ...new Set(
      assignments
        .filter((assignment) => assignment.revokedAt === null && assignment.role.isActive)
        .flatMap((assignment) => assignment.role.permissions),
    ),
  ].sort();
}

/**
 * The permissions one account actually loses when one of its roles is taken
 * back: the role's permissions that no *other* live, active role of the
 * account also grants. An inactive role grants nothing today, so taking it
 * back takes nothing away (auth.service reads `revokedAt: null` and
 * `role.isActive`).
 */
export function permissionsLostOnRevoke(assignments: readonly HeldAssignment[], roleId: string): string[] {
  const target = assignments.find((assignment) => assignment.revokedAt === null && assignment.role.id === roleId);
  if (!target || !target.role.isActive) return [];
  const kept = new Set(
    effectivePermissions(assignments.filter((assignment) => assignment.role.id !== roleId)),
  );
  return [...new Set(target.role.permissions)].filter((permission) => !kept.has(permission)).sort();
}
