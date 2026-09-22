import Link from 'next/link';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { EmptyState } from '../../../components/empty-state';
import {
  fetchOrNotFound,
  formatDateTime,
  getAdminRole,
  listAdminPermissionCatalogue,
  requireAdmin,
  userRoleBadgeClass,
  userRoleLabel,
} from '../../../lib/api';
import {
  replaceAdminRolePermissionsAction,
  setAdminRoleActiveAction,
  updateAdminRoleAction,
} from '../actions';
import { PermissionMatrix } from '../permission-matrix';

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

export default async function AdminRoleDetailPage({ params, searchParams }: RoleDetailPageProps) {
  await requireAdmin();
  const [{ id }, { error, ok }] = await Promise.all([params, searchParams]);
  const [role, catalogue] = await Promise.all([
    fetchOrNotFound(() => getAdminRole(id)),
    listAdminPermissionCatalogue(),
  ]);

  return (
    <>
      <PageHeader
        title={role.name}
        subtitle={role.description ?? 'Açıklama girilmemiş.'}
        breadcrumbs={[
          { href: '/roles', label: 'Roller' },
          { href: `/roles/${role.id}`, label: role.name },
        ]}
      />

      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : null}
      {ok ? (
        <div className="notice notice-success" role="status">
          {OK_MESSAGES[ok] ?? 'Kaydedildi.'}
        </div>
      ) : null}

      <div className="admin-meta-pills">
        <span className="meta-pill">
          anahtar <code>{role.key}</code>
        </span>
        <span className={role.isActive ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}>
          {role.isActive ? 'Aktif' : 'Pasif'}
        </span>
        <span className="meta-pill">{role.permissions.length} izin</span>
        <span className="meta-pill">güncellenme {formatDateTime(role.updatedAt)}</span>
      </div>

      <SectionCard title="Ad ve açıklama" subtitle="Anahtar değiştirilemez: audit kayıtları ona bakar.">
        <form action={updateAdminRoleAction} className="compact-form">
          <input type="hidden" name="roleId" value={role.id} />
          <div className="compact-field-grid">
            <label className="field field-12">
              <span>Ad *</span>
              <input name="name" defaultValue={role.name} required minLength={2} maxLength={120} />
            </label>
            <label className="field field-12">
              <span>Açıklama</span>
              <textarea name="description" rows={2} maxLength={500} defaultValue={role.description ?? ''} />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary btn-sm" type="submit">
              Kaydet
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title="İzinler"
        subtitle="İşaretli kutular rolün tamamıdır; kaydettiğinizde eski küme bunun yerine geçer."
      >
        <form action={replaceAdminRolePermissionsAction} className="compact-form">
          <input type="hidden" name="roleId" value={role.id} />
          <PermissionMatrix catalogue={catalogue.permissions} selected={role.permissions} />
          <div className="form-actions">
            <button className="btn btn-primary btn-sm" type="submit">
              İzinleri kaydet
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title={role.isActive ? 'Rolü pasifleştir' : 'Rolü yeniden aktifleştir'}
        subtitle={
          role.isActive
            ? 'Pasif bir rol kimseye izin vermez ve yeni atama kabul etmez. Atamalar silinmez; rol yeniden aktifleştirilirse geri gelirler.'
            : 'Aktifleştirdiğinizde bu rolü hâlâ taşıyan hesaplar izinlerini yeniden kazanır.'
        }
      >
        <form action={setAdminRoleActiveAction} className="compact-form">
          <input type="hidden" name="roleId" value={role.id} />
          <input type="hidden" name="isActive" value={role.isActive ? 'false' : 'true'} />
          {role.isActive ? (
            <label className="admin-confirm">
              <input type="checkbox" name="confirm" />
              <span>
                Bu rolü taşıyan {role.assignments.length} hesabın izinlerini kaybedeceğini anlıyorum.
              </span>
            </label>
          ) : null}
          <button className={role.isActive ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'} type="submit">
            {role.isActive ? 'Pasifleştir' : 'Aktifleştir'}
          </button>
        </form>
      </SectionCard>

      <SectionCard title="Bu rolü taşıyan hesaplar" subtitle="Atama ve geri alma kullanıcı detayından yapılır.">
        {role.assignments.length === 0 ? (
          <EmptyState title="Bu rol henüz kimseye atanmamış" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Hesap</th>
                <th>Rol türü</th>
                <th>Durum</th>
                <th>Atanma</th>
              </tr>
            </thead>
            <tbody>
              {role.assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <td>
                    <Link href={`/users/${assignment.user.id}`}>
                      {assignment.user.name ?? assignment.user.email ?? assignment.user.id}
                    </Link>
                  </td>
                  <td>
                    <span className={userRoleBadgeClass(assignment.user.role)}>
                      {userRoleLabel(assignment.user.role)}
                    </span>
                  </td>
                  <td>
                    <span className={assignment.user.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                      {assignment.user.isActive ? 'Aktif' : 'Pasif'}
                    </span>
                  </td>
                  <td>{formatDateTime(assignment.assignedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </>
  );
}
