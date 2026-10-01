import Link from 'next/link';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { SectionCard } from '../../../components/section-card';
import {
  adminPermissionLabel,
  formatDateTime,
  type AdminRoleSummary,
  type AdminUserRoles,
} from '../../../lib/api';
import {
  criticalPermissionsIn,
  permissionsGainedOnAssign,
  permissionsLostOnRevoke,
} from '../../../lib/permission-model';
import { assignAdminRoleAction, revokeAdminRoleAction } from '../../roles/actions';
import { RoleAssignForm } from './role-assign-form';
import type { LabelledPermission } from './user-activate-consequence';

type RoleAssignmentCardProps = {
  userId: string;
  /** How the confirmations name the account. */
  accountName: string;
  isSuperAdminViewer: boolean;
  roles: { assigned: AdminUserRoles; catalogue: AdminRoleSummary[] } | null;
};

const COLUMNS: DataColumn[] = [
  { key: 'role', label: 'Rol' },
  { key: 'permissions', label: 'İzin', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'assigned', label: 'Atanma' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

/**
 * The roles this staff account holds, and the way to change them.
 *
 * Only a super admin sees the controls, because only a super admin may use
 * them — handing out roles is a root capability with no permission value
 * (RG-7 §12.1). A staff account with ADMIN_USERS_READ still sees the page it
 * came from; it just gets a sentence here instead of buttons that would 403.
 *
 * "Geri al" asks first (ADMIN-DESIGN-001 Faz 3G). The dialog names the
 * permissions the account really loses: the role's permissions that no other
 * live, active role of the account also grants, computed from the assignment
 * list this card already read. The form and its fields are unchanged.
 *
 * "Ata" asks first too (ADMIN-DESTRUCTIVE-CONFIRMATION-001): see
 * `RoleAssignForm`, which also stops the select from starting on a role.
 *
 * Revoked assignments stay on screen, greyed. "This account used to be able to
 * do that" is the question an audit asks, and a list that quietly forgets
 * cannot answer it.
 */
export function AdminRoleAssignmentCard({ userId, accountName, isSuperAdminViewer, roles }: RoleAssignmentCardProps) {
  if (!isSuperAdminViewer || !roles) {
    return (
      <SectionCard title="Roller" className="is-wide" testId="user-roles-card">
        <p className="detail-muted-note">
          Rol atama ve geri alma yalnız süper adminlerde. Bu, izin kataloğunda karşılığı olmayan bir kök yetkidir:
          rolleri düzenleyebilen bir rol, kendisine her izni verebilirdi.
        </p>
      </SectionCard>
    );
  }

  const { assigned, catalogue } = roles;

  if (assigned.isSuperAdmin) {
    return (
      <SectionCard title="Roller" className="is-wide" testId="user-roles-card">
        <p className="detail-muted-note">
          Süper admin hesapları tüm izinlere zaten sahiptir; rol atanmaz. Bu hesaba yetki sınırı koymak istiyorsanız, onun
          yerine rol atanmış bir yönetici hesabı açın.
        </p>
      </SectionCard>
    );
  }

  const live = assigned.assignments.filter((assignment) => assignment.revokedAt === null);
  const revoked = assigned.assignments.filter((assignment) => assignment.revokedAt !== null);
  const heldRoleIds = new Set(live.map((assignment) => assignment.role.id));
  const assignable = catalogue.filter((role) => role.isActive && !heldRoleIds.has(role.id));

  return (
    <SectionCard
      title="Roller"
      subtitle="Bu hesabın yapabildiği her şey aşağıdaki aktif rollerin izinlerinin birleşimidir."
      className="is-wide"
      testId="user-roles-card"
    >
      {live.length === 0 ? (
        <EmptyState
          title="Atanmış rol yok"
          description="Rolü olmayan bir yönetici hesabı giriş yapabilir ama panele giremez."
        />
      ) : (
        <DataTable caption="Atanmış roller" columns={COLUMNS} minWidth={620} testId="user-role-table">
          {live.map((assignment) => (
            <tr key={assignment.id} data-testid="user-role-row" data-role-id={assignment.role.id}>
              <td>
                <Link className="cell-link cell-break" href={`/roles/${assignment.role.id}`} id={`user-role-${assignment.role.id}`}>
                  {assignment.role.name}
                </Link>
              </td>
              <td className="is-num">{assignment.role.permissions.length}</td>
              <td>
                <span className={assignment.role.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                  {assignment.role.isActive ? 'Aktif' : 'Rol pasif'}
                </span>
              </td>
              <td className="cell-nowrap">{formatDateTime(assignment.assignedAt)}</td>
              <td className="col-actions">
                <form action={revokeAdminRoleAction} className="inline-form">
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="roleId" value={assignment.role.id} />
                  <ConfirmDialog
                    triggerLabel="Geri al"
                    triggerClassName="btn btn-destructive btn-sm"
                    title={`"${assignment.role.name}" bu hesaptan geri alınsın mı?`}
                    consequence={
                      <RevokeConsequence
                        lost={permissionsLostOnRevoke(assigned.assignments, assignment.role.id)}
                        roleActive={assignment.role.isActive}
                        roleSize={assignment.role.permissions.length}
                      />
                    }
                    confirmLabel="Evet, geri al"
                    testId="user-role-revoke"
                  />
                </form>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      {assignable.length > 0 ? (
        // Keyed by what can still be assigned, so a landed assignment starts
        // the form again from "Rol seçin" rather than from a role now held.
        <RoleAssignForm
          key={assignable.map((role) => role.id).join(',')}
          userId={userId}
          accountName={accountName}
          roles={assignable.map((role) => {
            const gained = permissionsGainedOnAssign(assigned.assignments, role.permissions);
            return {
              id: role.id,
              name: role.name,
              permissionCount: role.permissions.length,
              gainedCount: gained.length,
              criticalGained: labelPermissions(criticalPermissionsIn(gained)),
            };
          })}
          action={assignAdminRoleAction}
        />
      ) : (
        <p className="detail-muted-note role-assign-empty">
          Atanabilecek başka aktif rol yok. <Link href="/roles">Roller ve İzinler</Link> ekranından yeni bir rol
          tanımlayabilirsiniz.
        </p>
      )}

      {revoked.length > 0 ? (
        <details className="role-revoked-list">
          <summary>Geri alınmış roller ({revoked.length})</summary>
          <ul className="muted">
            {revoked.map((assignment) => (
              <li key={assignment.id}>
                {assignment.role.name} · {formatDateTime(assignment.assignedAt)} →{' '}
                {formatDateTime(assignment.revokedAt!)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </SectionCard>
  );
}

/** What taking one role back does to this account, from its own assignment list. */
export function RevokeConsequence({
  lost,
  roleActive,
  roleSize,
}: {
  lost: string[];
  roleActive: boolean;
  roleSize: number;
}) {
  return (
    <>
      <p data-testid="user-role-revoke-impact">
        {!roleActive
          ? 'Rol pasif olduğu için bu hesaba şu an izin vermiyor; geri almak hesabın yetkisini değiştirmez.'
          : lost.length === 0
            ? `Rolün ${roleSize} izninin tamamı bu hesabın başka aktif bir rolünde de var; hesabın yetkisi değişmez.`
            : `Bu hesap ${lost.length} izni hemen kaybeder; açık oturumu bir sonraki isteğinde yeni yetkiyle çalışır.`}
      </p>
      {lost.length > 0 ? (
        <div className="confirm-change-list">
          <p className="confirm-change-title">Kaybedilecek izinler</p>
          <ul>
            {lost.map((permission) => {
              const { area, action } = adminPermissionLabel(permission);
              return (
                <li key={permission}>
                  {area} · {action} <code>{permission}</code>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <p>Atama silinmez, "Geri alınmış roller" listesinde kalır; rol yeniden atanabilir. Değişiklik adınızla kayda geçer.</p>
    </>
  );
}

/** Raw permission values with the panel's "Alan · işlem" line, for the confirmations. */
export function labelPermissions(permissions: readonly string[]): LabelledPermission[] {
  return permissions.map((permission) => {
    const { area, action } = adminPermissionLabel(permission);
    return { permission, label: `${area} · ${action}` };
  });
}
