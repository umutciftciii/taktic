import { adminPermissionLabel, type AdminPermission } from '../../lib/api';

/**
 * REL-002 Faz 4 — the permissions `GET /admin/permissions` returns under
 * `reservedForSuperAdmin`. They are named here, never offered as a checkbox:
 * a role cannot hold them (the API answers 400
 * PERMISSION_RESERVED_FOR_SUPER_ADMIN) and a super admin already has them.
 */
export function ReservedPermissionsNote({ reserved }: { reserved: readonly AdminPermission[] | undefined }) {
  if (!reserved || reserved.length === 0) return null;
  return (
    <p className="detail-muted-note" data-testid="role-reserved-permissions">
      Yalnız süper yönetici:{' '}
      {reserved.map((permission, index) => {
        const { area, action } = adminPermissionLabel(permission);
        return (
          <span key={permission}>
            {index > 0 ? ', ' : ''}
            {area} · {action} (<code>{permission}</code>)
          </span>
        );
      })}
      . Bu izinler bir role verilemez.
    </p>
  );
}
