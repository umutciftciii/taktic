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

export type HeldAssignment = {
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

/**
 * The permissions a confirmation names out loud when an account is about to
 * gain them (ADMIN-DESTRUCTIVE-CONFIRMATION-001): the ones that move money or
 * credit, mint a link that signs somebody in or takes over a profile, open
 * sensitive identity data, switch the promotion engine, end something for good,
 * or change who else may act. Every other permission is still counted; these
 * are the ones a reader should not have to find in a list of sixty.
 *
 * Plain strings rather than `AdminPermission` so the client forms can import
 * this file without `lib/api`; `permission-model.spec` holds every entry to a
 * real enum value.
 */
export const CRITICAL_PERMISSIONS: readonly string[] = [
  'CREDITS_GRANT',
  'CREDITS_DEDUCT',
  'OFFER_REFUND_EXECUTE',
  'OFFER_REFUND_MANUAL',
  'PACKAGE_REFUND_APPROVE',
  'PACKAGE_PURCHASE_STATUS_WRITE',
  'REQUESTS_CANCEL_WITHOUT_REFUND',
  'CAMPAIGN_ENGINE_TOGGLE',
  'CAMPAIGNS_LIFECYCLE',
  'CAMPAIGN_REDEMPTION_REVOKE',
  'CUSTOMER_ACTIVATION_LINK_ISSUE',
  'PROVIDER_CLAIM_INVITE_ISSUE',
  'PROVIDER_INVITES_ISSUE',
  'PROVIDER_REGISTRATION_READ_SENSITIVE',
  'SHOWCASE_PLACEMENT_CANCEL',
  'CATEGORIES_DELETE',
  'QUESTIONS_DELETE',
  'ADMIN_USERS_STATUS',
];

/** The critical permissions in `permissions`, in catalogue order of the list above. */
export function criticalPermissionsIn(permissions: readonly string[]): string[] {
  const held = new Set(permissions);
  return CRITICAL_PERMISSIONS.filter((permission) => held.has(permission));
}

/**
 * What assigning `rolePermissions` to an account would really add: the role's
 * permissions its live, active roles do not already grant. An inactive role
 * cannot be assigned (the API refuses), so the role is taken as granting.
 */
export function permissionsGainedOnAssign(
  assignments: readonly HeldAssignment[],
  rolePermissions: readonly string[],
): string[] {
  const held = new Set(effectivePermissions(assignments));
  return [...new Set(rolePermissions)].filter((permission) => !held.has(permission)).sort();
}
