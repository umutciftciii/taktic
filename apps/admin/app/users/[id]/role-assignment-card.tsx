import Link from 'next/link';
import { SectionCard } from '../../../components/section-card';
import { EmptyState } from '../../../components/empty-state';
import { formatDateTime, type AdminRoleSummary, type AdminUserRoles } from '../../../lib/api';
import { assignAdminRoleAction, revokeAdminRoleAction } from '../../roles/actions';

type RoleAssignmentCardProps = {
  userId: string;
  isSuperAdminViewer: boolean;
  roles: { assigned: AdminUserRoles; catalogue: AdminRoleSummary[] } | null;
};

/**
 * The roles this staff account holds, and the way to change them.
 *
 * Only a super admin sees the controls, because only a super admin may use
 * them — handing out roles is a root capability with no permission value
 * (RG-7 §12.1). A staff account with ADMIN_USERS_READ still sees the page it
 * came from; it just gets a sentence here instead of buttons that would 403.
 *
 * Revoked assignments stay on screen, greyed. "This account used to be able to
 * do that" is the question an audit asks, and a list that quietly forgets
 * cannot answer it.
 */
export function AdminRoleAssignmentCard({ userId, isSuperAdminViewer, roles }: RoleAssignmentCardProps) {
  if (!isSuperAdminViewer || !roles) {
    return (
      <SectionCard title="Roller" className="card-wide">
        <p className="muted">
          Rol atama ve geri alma yalnız süper adminlerde. Bu, izin kataloğunda karşılığı olmayan bir kök
          yetkidir: rolleri düzenleyebilen bir rol, kendisine her izni verebilirdi.
        </p>
      </SectionCard>
    );
  }

  const { assigned, catalogue } = roles;

  if (assigned.isSuperAdmin) {
    return (
      <SectionCard title="Roller" className="card-wide">
        <p className="muted">
          Süper admin hesapları tüm izinlere zaten sahiptir; rol atanmaz. Bu hesaba yetki sınırı koymak
          istiyorsanız, onun yerine rol atanmış bir yönetici hesabı açın.
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
      className="card-wide"
    >
      {live.length === 0 ? (
        <EmptyState
          title="Atanmış rol yok"
          description="Rolü olmayan bir yönetici hesabı giriş yapabilir ama panele giremez."
        />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Rol</th>
              <th>İzin</th>
              <th>Durum</th>
              <th>Atanma</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((assignment) => (
              <tr key={assignment.id}>
                <td>
                  <Link href={`/roles/${assignment.role.id}`}>{assignment.role.name}</Link>
                </td>
                <td>{assignment.role.permissions.length}</td>
                <td>
                  <span className={assignment.role.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                    {assignment.role.isActive ? 'Aktif' : 'Rol pasif'}
                  </span>
                </td>
                <td>{formatDateTime(assignment.assignedAt)}</td>
                <td>
                  <form action={revokeAdminRoleAction}>
                    <input type="hidden" name="userId" value={userId} />
                    <input type="hidden" name="roleId" value={assignment.role.id} />
                    <button className="btn btn-danger btn-sm" type="submit">
                      Geri al
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {assignable.length > 0 ? (
        <form action={assignAdminRoleAction} className="compact-form" style={{ marginTop: 16 }}>
          <input type="hidden" name="userId" value={userId} />
          <div className="compact-field-grid">
            <label className="field field-12">
              <span>Rol ata</span>
              <select name="roleId" required>
                {assignable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.permissions.length} izin)
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary btn-sm" type="submit">
              Ata
            </button>
          </div>
        </form>
      ) : (
        <p className="muted" style={{ marginTop: 16 }}>
          Atanabilecek başka aktif rol yok. <Link href="/roles">Roller ve İzinler</Link> ekranından yeni bir rol
          tanımlayabilirsiniz.
        </p>
      )}

      {revoked.length > 0 ? (
        <details style={{ marginTop: 16 }}>
          <summary>Geri alınmış roller ({revoked.length})</summary>
          <ul className="muted" style={{ marginTop: 8 }}>
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
