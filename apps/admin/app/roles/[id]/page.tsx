import Link from 'next/link';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { DetailFormFooter, LockedField } from '../../../components/detail-form-footer';
import { DetailHeader } from '../../../components/detail-header';
import { EmptyState } from '../../../components/empty-state';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import {
  fetchOrNotFound,
  formatDateTime,
  getAdminRole,
  listAdminPermissionCatalogue,
  requireSuperAdmin,
  userRoleBadgeClass,
  userRoleLabel,
} from '../../../lib/api';
import { groupPermissions } from '../../../lib/permission-groups';
import { criticalPermissionsIn, permissionLines, roleReach } from '../../../lib/permission-model';
import {
  replaceAdminRolePermissionsAction,
  setAdminRoleActiveAction,
  updateAdminRoleAction,
} from '../actions';
import { RolePermissionsForm, RoleStatusForm } from '../role-forms';

type RoleDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
};

const OK_MESSAGES: Record<string, string> = {
  created: 'Rol oluşturuldu.',
  updated: 'Rol bilgileri güncellendi.',
  permissions: 'İzinler güncellendi.',
  activated: 'Rol yeniden aktifleştirildi.',
  deactivated: 'Rol pasifleştirildi; bu rolü taşıyan hesaplar izinlerini kaybetti.',
};

const HOLDER_COLUMNS: DataColumn[] = [
  { key: 'account', label: 'Hesap' },
  { key: 'kind', label: 'Hesap türü' },
  { key: 'status', label: 'Durum' },
  { key: 'assigned', label: 'Atanma' },
];

/**
 * One role (#52, ADMIN-DESIGN-001 Faz 3G), for the super admin alone. The
 * design has no screen for it; it is built on the detail template: a way back
 * to the roles, the summary card (status, key, name, description, a strip with
 * how many permissions it grants and how many accounts hold it) with
 * Pasifleştir / Aktifleştir, then the permission matrix, the name form and the
 * accounts holding it.
 *
 * Four writes ask first, with the figures this page read:
 * - İzinleri kaydet: what is added and removed, and the role's live holders
 *   (`GET /admin/roles/:id` → `assignments`, `revokedAt: null`) with how many
 *   of them are active.
 * - Rolü pasifleştir: the same holders, and the permissions they lose.
 * - Rolü aktifleştir: the same holders, who get the permissions back
 *   (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 * Renaming is undone by the same control and does not.
 *
 * Every one of those writes is refused by its action without the dialog's
 * single-use confirmation proof (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 */
export default async function AdminRoleDetailPage({ params, searchParams }: RoleDetailPageProps) {
  await requireSuperAdmin();
  const [{ id }, { error, ok }] = await Promise.all([params, searchParams]);
  const [role, catalogue] = await Promise.all([
    fetchOrNotFound(() => getAdminRole(id)),
    listAdminPermissionCatalogue(),
  ]);
  const groups = groupPermissions(catalogue.permissions);
  const reach = roleReach(role.assignments);
  const lines = permissionLines(groups);
  const areaCount = groups.filter((group) => group.items.some((item) => role.permissions.includes(item.permission))).length;

  const facts: SummaryItem[] = [
    {
      label: 'İzin',
      value: `${role.permissions.length} / ${catalogue.permissions.length}`,
      note: `${areaCount} alanda`,
      testId: 'role-fact-permissions',
    },
    {
      label: 'Taşıyan hesap',
      value: reach.holders,
      note: `${reach.activeHolders} tanesi aktif`,
      testId: 'role-fact-holders',
    },
    {
      label: 'Durum',
      value: role.isActive ? 'Aktif' : 'Pasif',
      note: role.isActive ? 'izinleri geçerli' : 'kimseye izin vermez',
      tone: role.isActive ? 'success' : 'warning',
    },
    { label: 'Oluşturulma', value: formatDateTime(role.createdAt) },
    { label: 'Güncellenme', value: formatDateTime(role.updatedAt) },
  ];

  return (
    <main className="system-page role-detail-page">
      <DetailHeader
        back={{ href: '/roles', label: 'Roller ve izinler' }}
        badges={
          <span className={role.isActive ? 'badge badge-good' : 'badge badge-muted'} data-testid="role-status">
            {role.isActive ? 'Aktif' : 'Pasif'}
          </span>
        }
        meta={
          <>
            anahtar <code className="cell-break">{role.key}</code>
          </>
        }
        title={role.name}
        subtitle={role.description ?? 'Açıklama girilmemiş.'}
        actions={
          <RoleStatusForm
            roleId={role.id}
            roleName={role.name}
            isActive={role.isActive}
            permissionCount={role.permissions.length}
            reach={reach}
            criticalPermissions={criticalPermissionsIn(role.permissions).map((permission) => ({
              permission,
              label: lines.get(permission) ?? permission,
            }))}
            action={setAdminRoleActiveAction}
          />
        }
        facts={facts}
        factsLabel="Rol özeti"
        testId="role-header"
      />

      {error ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="role-error">
          {error}
        </div>
      ) : null}
      {ok ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="role-ok">
          {OK_MESSAGES[ok] ?? 'Kaydedildi.'}
        </div>
      ) : null}

      <div className="detail-panel">
        <SectionCard
          title="İzinler"
          actions={<span className="section-card-meta">İşaretli kutular rolün tamamıdır; kayıt eski kümenin yerine geçer.</span>}
          className="detail-tab-card"
          testId="role-permissions-card"
        >
          {/* Keyed by the stored set, so a landed save starts the form from it. */}
          <RolePermissionsForm
            key={role.permissions.join(',')}
            roleId={role.id}
            groups={groups}
            selected={role.permissions}
            reach={reach}
            roleActive={role.isActive}
            action={replaceAdminRolePermissionsAction}
          />
        </SectionCard>

        <div className="detail-panel-grid">
          <SectionCard title="Ad ve açıklama" className="detail-tab-card" testId="role-info-card">
            <form action={updateAdminRoleAction} className="compact-form">
              <input type="hidden" name="roleId" value={role.id} />
              <div className="compact-field-grid">
                <LockedField
                  label="Anahtar"
                  value={<code>{role.key}</code>}
                  help="Denetim kayıtları rolü anahtarıyla anar."
                  className="field field-12"
                />
                <label className="field field-12">
                  <span>Ad *</span>
                  <input name="name" defaultValue={role.name} required minLength={2} maxLength={120} />
                </label>
                <label className="field field-12">
                  <span>Açıklama</span>
                  <textarea name="description" rows={3} maxLength={500} defaultValue={role.description ?? ''} />
                </label>
              </div>
              <DetailFormFooter note="Ad ve açıklamayı değiştirmek rolün izinlerini ve atamalarını değiştirmez.">
                <button className="btn btn-primary" type="submit">
                  Kaydet
                </button>
              </DetailFormFooter>
            </form>
          </SectionCard>

          <SectionCard
            title="Bu rolü taşıyan hesaplar"
            actions={<span className="section-card-meta">Atama ve geri alma kullanıcı detayından yapılır.</span>}
            className="detail-tab-card"
            testId="role-holders-card"
          >
            {role.assignments.length === 0 ? (
              <EmptyState title="Bu rol henüz kimseye atanmamış" />
            ) : (
              <DataTable caption="Bu rolü taşıyan hesaplar" columns={HOLDER_COLUMNS} minWidth={560} testId="role-holders">
                {role.assignments.map((assignment) => (
                  <tr key={assignment.id}>
                    <td>
                      <Link className="cell-link cell-break" href={`/users/${assignment.user.id}`}>
                        {assignment.user.name ?? assignment.user.email ?? assignment.user.id}
                      </Link>
                    </td>
                    <td>
                      <span className={userRoleBadgeClass(assignment.user.role)}>{userRoleLabel(assignment.user.role)}</span>
                    </td>
                    <td>
                      <span className={assignment.user.isActive ? 'badge badge-good' : 'badge badge-bad'}>
                        {assignment.user.isActive ? 'Aktif' : 'Pasif'}
                      </span>
                    </td>
                    <td className="cell-nowrap">{formatDateTime(assignment.assignedAt)}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
