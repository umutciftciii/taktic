import { adminPermissionLabel, type AdminPermission } from './api';
import type { PermissionGroup, PermissionGroupItem } from './permission-model';

/**
 * The permission catalogue as the role screens draw it (ADMIN-DESIGN-001
 * Faz 3G): every value `GET /admin/permissions` returns, grouped by the area
 * `adminPermissionLabel` names, areas in Turkish alphabetical order and each
 * area's permissions in catalogue order. Nothing is dropped, renamed or added
 * here — the matrix is a view of the closed catalogue, not a copy of it.
 *
 * Server-side, because `lib/api` is: the labels are computed on the page and
 * handed to the client matrix as plain data.
 */
export function groupPermissions(catalogue: readonly AdminPermission[]): PermissionGroup[] {
  const groups = new Map<string, PermissionGroupItem[]>();
  for (const permission of catalogue) {
    const { area, action } = adminPermissionLabel(permission);
    const items = groups.get(area) ?? [];
    items.push({ permission, action });
    groups.set(area, items);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'tr'))
    .map(([area, items]) => ({ area, items }));
}
