import { adminPermissionLabel, type AdminPermission } from '../../lib/api';

type PermissionMatrixProps = {
  catalogue: AdminPermission[];
  selected: AdminPermission[];
  /** Read-only rendering for a screen that shows a role without editing it. */
  disabled?: boolean;
};

/**
 * The catalogue as tick boxes, grouped by the area each permission names.
 *
 * Grouped rather than listed flat because 76 checkboxes in one column is a wall
 * an operator cannot read, and because the decisions people actually make are
 * per area: "this role handles support", "this role touches money". The areas
 * come from the permission names themselves (`adminPermissionLabel`), so a new
 * permission lands in the right group without this file changing.
 *
 * Every box is a value of the closed catalogue. There is no free-text field and
 * no "add permission" control, because a permission the API does not know is
 * not something a screen may invent (design D11).
 */
export function PermissionMatrix({ catalogue, selected, disabled }: PermissionMatrixProps) {
  const held = new Set(selected);
  const groups = new Map<string, AdminPermission[]>();

  for (const permission of catalogue) {
    const { area } = adminPermissionLabel(permission);
    const list = groups.get(area) ?? [];
    list.push(permission);
    groups.set(area, list);
  }

  return (
    <div className="admin-permission-matrix">
      {[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b, 'tr'))
        .map(([area, permissions]) => (
          <fieldset className="admin-permission-group" key={area}>
            <legend>{area}</legend>
            <ul className="admin-permission-list">
              {permissions.map((permission) => {
                const { action } = adminPermissionLabel(permission);
                return (
                  <li key={permission}>
                    <label className="admin-permission-item">
                      <input
                        type="checkbox"
                        name="permissions"
                        value={permission}
                        defaultChecked={held.has(permission)}
                        disabled={disabled}
                      />
                      <span className="admin-permission-action">{action}</span>
                      <code className="admin-permission-code">{permission}</code>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}
    </div>
  );
}
