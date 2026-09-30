'use client';

import { useEffect, useRef, useState } from 'react';
import type { PermissionGroup } from '../../lib/permission-model';

type PermissionMatrixProps = {
  /** The whole catalogue, grouped on the page (`groupPermissions`). */
  groups: PermissionGroup[];
  /** What the form starts with: the role's set, or nothing for a new role. */
  selected: readonly string[];
  /** Told the ticked set on every change and after a form reset. */
  onSelectionChange?: (selected: string[]) => void;
  testId?: string;
};

/**
 * The catalogue as tick boxes, grouped by the area each permission names.
 *
 * Grouped rather than listed flat because 84 checkboxes in one column is a wall
 * an operator cannot read, and because the decisions people actually make are
 * per area: "this role handles support", "this role touches money". The areas
 * come from the permission names themselves (`adminPermissionLabel`, applied
 * on the page), so a new permission lands in the right group without this
 * file changing. Each box keeps the Turkish label and, on a second line, the
 * raw value the API refuses by and the audit row records.
 *
 * Every box is a value of the closed catalogue. There is no free-text field and
 * no "add permission" control, because a permission the API does not know is
 * not something a screen may invent (design D11).
 *
 * The boxes are plain uncontrolled checkboxes named `permissions`, so the form
 * posts exactly what it did before and works without JavaScript. The counts
 * (overall and per area) are read back from the boxes on every change and
 * after the form's Vazgeç (reset).
 */
export function PermissionMatrix({ groups, selected, onSelectionChange, testId }: PermissionMatrixProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set(selected));
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  function readBoxes() {
    const root = rootRef.current;
    if (!root) return;
    const ticked = [...root.querySelectorAll<HTMLInputElement>('input[name="permissions"]')]
      .filter((box) => box.checked)
      .map((box) => box.value);
    setHeld(new Set(ticked));
    onSelectionChangeRef.current?.(ticked);
  }

  useEffect(() => {
    const root = rootRef.current;
    const form = root?.closest('form');
    if (!root) return;
    // Native listeners, not React's onChange: after a form reset React's value
    // tracker still holds the pre-reset state, so ticking a box back to what
    // it was before the reset would not reach an onChange handler at all.
    const onChange = () => readBoxes();
    // `reset` fires before the boxes are restored.
    const onReset = () => window.setTimeout(readBoxes, 0);
    root.addEventListener('change', onChange);
    form?.addEventListener('reset', onReset);
    return () => {
      root.removeEventListener('change', onChange);
      form?.removeEventListener('reset', onReset);
    };
  }, []);

  return (
    <div className="admin-permission-matrix-wrap" ref={rootRef} data-testid={testId}>
      <p className="admin-permission-summary" aria-live="polite" data-testid="permission-matrix-summary">
        {total} izinden <strong>{held.size}</strong> tanesi seçili · {groups.length} alan
      </p>
      <div className="admin-permission-matrix">
        {groups.map((group) => {
          const count = group.items.filter((item) => held.has(item.permission)).length;
          return (
            <fieldset className="admin-permission-group" key={group.area} data-testid="permission-group" data-area={group.area}>
              <legend>
                <span>{group.area}</span>
                <span className="admin-permission-count" data-testid="permission-group-count">
                  {count}/{group.items.length}
                </span>
              </legend>
              <ul className="admin-permission-list">
                {group.items.map((item) => (
                  <li key={item.permission}>
                    <label className="admin-permission-item">
                      <input
                        type="checkbox"
                        name="permissions"
                        value={item.permission}
                        defaultChecked={selected.includes(item.permission)}
                      />
                      <span className="admin-permission-action">{item.action}</span>
                      <code className="admin-permission-code">{item.permission}</code>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

