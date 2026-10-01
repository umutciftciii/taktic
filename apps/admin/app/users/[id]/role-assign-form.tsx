'use client';

import { useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import type { LabelledPermission } from './user-activate-consequence';

/** One role the account could be given, with what it would really add. */
export type AssignableRole = {
  id: string;
  name: string;
  permissionCount: number;
  /** The role's permissions the account's live, active roles do not already grant. */
  gainedCount: number;
  /** The critical ones among `gained`, labelled by the server page. */
  criticalGained: LabelledPermission[];
};

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * "Rol ata" (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 *
 * Two changes from the one-click form it replaces, both about not handing out
 * access by accident:
 *
 * - The select starts on an empty "Rol seçin" choice, not on the first role. A
 *   first role preselected meant one click on "Ata" assigned whatever sorted
 *   first. The trigger stays shut until a role is picked, and the browser's
 *   `required` check stops the dialog too.
 * - "Ata" asks first, naming the account, the role, how many permissions it
 *   carries, how many of them are new to this account and which of the new
 *   ones are critical.
 *
 * The form, its fields (`userId`, `roleId`) and `assignAdminRoleAction` are
 * unchanged; the server's audit row is written exactly as before.
 */
export function RoleAssignForm({
  userId,
  accountName,
  roles,
  action,
}: {
  userId: string;
  accountName: string;
  roles: AssignableRole[];
  action: FormAction;
}) {
  const [roleId, setRoleId] = useState('');
  const selected = roles.find((role) => role.id === roleId) ?? null;

  return (
    <form action={action} className="compact-form role-assign-form" data-testid="user-role-assign">
      <input type="hidden" name="userId" value={userId} />
      <div className="compact-field-grid">
        <label className="field field-8">
          <span>Rol ata</span>
          <select
            name="roleId"
            required
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
            data-testid="user-role-assign-select"
          >
            <option value="" disabled>
              Rol seçin…
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name} ({role.permissionCount} izin)
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-actions">
        <ConfirmDialog
          proof="role.assign"
          triggerLabel="Ata"
          triggerClassName="btn btn-primary btn-sm"
          tone="primary"
          title={selected ? `"${selected.name}" bu hesaba atansın mı?` : 'Rol atansın mı?'}
          consequence={selected ? <RoleAssignConsequence accountName={accountName} role={selected} /> : null}
          confirmLabel="Evet, rolü ata"
          disabled={selected === null}
          testId="user-role-assign-submit"
        />
      </div>
    </form>
  );
}

/** What assigning one role does to this account, from its own assignment list. */
export function RoleAssignConsequence({ accountName, role }: { accountName: string; role: AssignableRole }) {
  const alreadyHeld = role.permissionCount - role.gainedCount;
  return (
    <>
      <p data-testid="user-role-assign-impact">
        <strong>{accountName}</strong> hesabına <strong>“{role.name}”</strong> rolü atanır. Rol {role.permissionCount}{' '}
        izin taşır;{' '}
        {role.gainedCount === 0
          ? 'hepsi bu hesabın başka aktif bir rolünde zaten var, hesabın bugünkü yetkisi değişmez.'
          : alreadyHeld === 0
            ? `hesap ${role.gainedCount} iznin tamamını hemen kazanır.`
            : `hesap bunlardan ${role.gainedCount} yeni izni hemen kazanır (${alreadyHeld} tanesi başka bir rolünden zaten var).`}{' '}
        Açık oturumu bir sonraki isteğinde yeni yetkiyle çalışır.
      </p>
      {role.criticalGained.length > 0 ? (
        <div className="confirm-change-list" data-testid="user-role-assign-critical">
          <p className="confirm-change-title">Kazanacağı kritik izinler</p>
          <ul>
            {role.criticalGained.map((item) => (
              <li key={item.permission}>
                {item.label} <code>{item.permission}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p>
        Atama sizin adınızla kayda geçer ve bu ekrandaki “Geri al” ile alınabilir. Rolün izinleri sonradan değiştirilirse
        bu hesabın yetkisi de onunla birlikte değişir.
      </p>
    </>
  );
}
